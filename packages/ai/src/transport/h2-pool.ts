import type { ClientHttp2Stream } from "node:http2";
import { constants as http2Constants } from "node:http2";
import { Http2SessionManager } from "@connectrpc/connect-node";
import * as AIError from "../error";
import { connectProxiedSocket, getProxyForProvider, shouldBypassProxy } from "../utils/proxy";
import { isTransportDisposed, registerTransportDisposer } from "./lifecycle";

const POOL_SIZE = 4;
const PING_INTERVAL_MS = 10_000;
const PING_TIMEOUT_MS = 20_000;
const PROXY_TUNNEL_TIMEOUT_MS = 30_000;

type HealthySlot = { kind: "healthy"; generation: number; manager: Http2SessionManager; leases: number };
type SlotState =
	| { kind: "vacant" }
	| { kind: "initializing"; generation: number; promise: Promise<Http2SessionManager>; abort: AbortController }
	| HealthySlot;

interface PoolEntry {
	slots: SlotState[];
	roundRobin: number;
}

interface RetiringManager {
	manager: Http2SessionManager;
	leases: number;
}

export interface H2Lease {
	request(headers: Record<string, string>, options?: { signal?: AbortSignal }): Promise<ClientHttp2Stream>;
	release(): void;
}

const pools = new Map<string, PoolEntry>();
const retiringManagers = new Set<RetiringManager>();
let nextGeneration = 1;
let poolDisposing = false;
let poolDisposalPromise: Promise<void> | undefined;

function waitWithSignal<T>(
	source: Promise<T>,
	signal: AbortSignal | undefined,
	onLateValue?: (value: T) => void,
): Promise<T> {
	if (!signal) return source;
	if (signal.aborted) return Promise.reject(new AIError.AbortError());
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	const onAbort = (): void => {
		if (settled) return;
		settled = true;
		signal.removeEventListener("abort", onAbort);
		reject(new AIError.AbortError());
	};
	signal.addEventListener("abort", onAbort, { once: true });
	source.then(
		value => {
			if (settled) {
				onLateValue?.(value);
				return;
			}
			settled = true;
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		},
		error => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			reject(error);
		},
	);
	return promise;
}

function closeManager(manager: Http2SessionManager, reason?: Error): void {
	try {
		manager.abort(reason);
	} catch {
		// Disposal is best-effort and must continue draining the other managers.
	}
}

function retireManager(entry: PoolEntry, slotIndex: number, slot: HealthySlot): void {
	const current = entry.slots[slotIndex];
	if (current.kind !== "healthy" || current.generation !== slot.generation) return;
	const retiring = { manager: current.manager, leases: current.leases };
	entry.slots[slotIndex] = { kind: "vacant" };
	if (retiring.leases === 0) {
		closeManager(retiring.manager);
		return;
	}
	retiringManagers.add(retiring);
}

async function createSessionManager(
	baseUrl: string,
	origin: string,
	proxyUrl: string | undefined,
	signal: AbortSignal,
): Promise<Http2SessionManager> {
	const pingOptions = {
		pingIntervalMs: PING_INTERVAL_MS,
		pingTimeoutMs: PING_TIMEOUT_MS,
		pingIdleConnection: true,
	};
	let manager: Http2SessionManager;
	if (proxyUrl) {
		const socket = await connectProxiedSocket(proxyUrl, baseUrl, {
			signal,
			timeoutMs: PROXY_TUNNEL_TIMEOUT_MS,
		});
		manager = new Http2SessionManager(origin, pingOptions, { createConnection: () => socket });
	} else {
		manager = new Http2SessionManager(origin, pingOptions);
	}
	const state = await manager.connect();
	if (state === "error") {
		const managerError = manager.error() ?? new Error(`HTTP/2 connection to ${origin} failed`);
		const error =
			managerError && typeof managerError === "object" && "cause" in managerError && managerError.cause
				? managerError.cause
				: managerError;
		closeManager(manager, managerError instanceof Error ? managerError : undefined);
		throw error;
	}
	if (signal.aborted) {
		closeManager(manager, new AIError.AbortError());
		throw new AIError.AbortError();
	}
	return manager;
}

function makeLease(entry: PoolEntry, slotIndex: number, slot: HealthySlot): H2Lease {
	const { generation, manager } = slot;
	let released = false;
	return {
		async request(headers, options) {
			if (released) throw new Error("Cannot request from a released HTTP/2 lease");
			if (options?.signal?.aborted) throw new AIError.AbortError();
			const method = headers[":method"] ?? "POST";
			const path = headers[":path"];
			if (!path) throw new AIError.ValidationError("HTTP/2 request headers require :path");
			const requestHeaders = { ...headers, te: headers.te ?? "trailers" };
			const pending = manager.request(method, path, requestHeaders, {});
			const stream = await waitWithSignal(pending, options?.signal, late => {
				late.close(http2Constants.NGHTTP2_CANCEL);
			});
			const signal = options?.signal;
			const onAbort = (): void => stream.close(http2Constants.NGHTTP2_CANCEL);
			signal?.addEventListener("abort", onAbort, { once: true });
			stream.once("close", () => signal?.removeEventListener("abort", onAbort));
			stream.on("data", () => manager.notifyResponseByteRead(stream));
			return stream;
		},
		release() {
			if (released) return;
			released = true;
			const current = entry.slots[slotIndex];
			if (current.kind === "healthy" && current.generation === generation) {
				current.leases = Math.max(0, current.leases - 1);
				return;
			}
			for (const retiring of retiringManagers) {
				if (retiring.manager !== manager) continue;
				retiring.leases = Math.max(0, retiring.leases - 1);
				if (retiring.leases === 0) {
					retiringManagers.delete(retiring);
					closeManager(retiring.manager);
				}
				return;
			}
		},
	};
}

async function acquireFromSlot(
	entry: PoolEntry,
	slotIndex: number,
	baseUrl: string,
	origin: string,
	proxyUrl: string | undefined,
	signal: AbortSignal | undefined,
): Promise<H2Lease> {
	let slot = entry.slots[slotIndex];
	if (slot.kind === "healthy" && (slot.manager.state() === "error" || slot.manager.state() === "closed")) {
		retireManager(entry, slotIndex, slot);
		slot = entry.slots[slotIndex];
	}
	if (slot.kind === "healthy") {
		const state = await waitWithSignal(slot.manager.connect(), signal);
		if (state === "error") {
			retireManager(entry, slotIndex, slot);
			slot = entry.slots[slotIndex];
		}
	}

	if (slot.kind === "vacant") {
		const generation = nextGeneration++;
		const abort = new AbortController();
		const promise = createSessionManager(baseUrl, origin, proxyUrl, abort.signal);
		entry.slots[slotIndex] = { kind: "initializing", generation, promise, abort };
		promise.then(
			manager => {
				const current = entry.slots[slotIndex];
				if (
					poolDisposing ||
					isTransportDisposed() ||
					current.kind !== "initializing" ||
					current.generation !== generation
				) {
					closeManager(manager);
					return;
				}
				entry.slots[slotIndex] = { kind: "healthy", generation, manager, leases: 0 };
			},
			() => {
				const current = entry.slots[slotIndex];
				if (current.kind === "initializing" && current.generation === generation) {
					entry.slots[slotIndex] = { kind: "vacant" };
				}
			},
		);
		await waitWithSignal(promise, signal);
		slot = entry.slots[slotIndex];
	}

	if (slot.kind === "initializing") {
		await waitWithSignal(slot.promise, signal);
		slot = entry.slots[slotIndex];
	}
	if (slot.kind !== "healthy") throw new Error("HTTP/2 pool slot did not become healthy");
	if (signal?.aborted) throw new AIError.AbortError();
	slot.leases++;
	return makeLease(entry, slotIndex, slot);
}

export async function acquireH2Session(baseUrl: string, provider: string, signal?: AbortSignal): Promise<H2Lease> {
	if (poolDisposing || isTransportDisposed()) throw new Error("HTTP/2 transport has been disposed");
	if (signal?.aborted) throw new AIError.AbortError();
	const url = new URL(baseUrl);
	const origin = `${url.protocol}//${url.host}`;
	const proxyUrl = shouldBypassProxy(url) ? undefined : getProxyForProvider(provider);
	const key = `${origin}|${proxyUrl ?? ""}`;
	let entry = pools.get(key);
	if (!entry) {
		entry = { slots: Array.from({ length: POOL_SIZE }, () => ({ kind: "vacant" })), roundRobin: 0 };
		pools.set(key, entry);
	}

	let originatingError: unknown;
	for (let attempt = 0; attempt < POOL_SIZE; attempt++) {
		const slotIndex = (entry.roundRobin + attempt) % POOL_SIZE;
		try {
			const lease = await acquireFromSlot(entry, slotIndex, baseUrl, origin, proxyUrl, signal);
			entry.roundRobin = (slotIndex + 1) % POOL_SIZE;
			return lease;
		} catch (error) {
			if (error instanceof AIError.AbortError) throw error;
			originatingError ??= error;
		}
	}
	throw originatingError ?? new Error("HTTP/2 session acquisition failed");
}

export function disposeH2Pool(): Promise<void> {
	if (poolDisposalPromise) return poolDisposalPromise;
	poolDisposing = true;
	poolDisposalPromise = (async () => {
		try {
			const reason = new Error("HTTP/2 pool disposed");
			const initializers: Promise<unknown>[] = [];
			for (const entry of pools.values()) {
				for (const slot of entry.slots) {
					if (slot.kind === "healthy") closeManager(slot.manager, reason);
					else if (slot.kind === "initializing") {
						slot.abort.abort(reason);
						initializers.push(slot.promise.catch(() => undefined));
					}
				}
			}
			for (const retiring of retiringManagers) closeManager(retiring.manager, reason);
			pools.clear();
			retiringManagers.clear();
			await Promise.all(initializers);
		} finally {
			poolDisposing = false;
			poolDisposalPromise = undefined;
		}
	})();
	return poolDisposalPromise;
}

registerTransportDisposer("h2-pool", disposeH2Pool);
