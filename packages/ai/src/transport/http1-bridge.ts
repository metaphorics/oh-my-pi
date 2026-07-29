import type { Interceptor, Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { createProxiedAgent, getProxyForUrl } from "../utils/proxy";
import { isTransportDisposed, registerTransportDisposer } from "./lifecycle";

const MAX_IN_FLIGHT = 16;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

export interface Http1PollFrame {
	seqno: bigint;
	data: string;
	eof: boolean;
}

export interface Http1BridgeRpc<TMessage> {
	append(seqno: bigint, data: Uint8Array, signal: AbortSignal): Promise<void>;
	receive(signal: AbortSignal): AsyncIterable<TMessage>;
	poll(signal: AbortSignal): AsyncIterable<Http1PollFrame>;
	decodePoll(data: string): TMessage;
}

export interface Http1Bridge<TMessage> {
	readonly messages: AsyncIterable<TMessage>;
	send(data: Uint8Array): Promise<void>;
	close(reason: "success" | "abort" | "dispose"): Promise<void>;
	close(reason: "fatal", error: Error): Promise<void>;
}

export interface Http1BridgeOptions<TMessage> {
	baseUrl: string;
	provider: string;
	headers: Record<string, string>;
	requestBytes: Uint8Array;
	createRpc(transport: Transport): Http1BridgeRpc<TMessage>;
	heartbeatBytes?: Uint8Array;
	heartbeatIntervalMs?: number;
	signal?: AbortSignal;
	isRecoverableReceiveError?(error: unknown): boolean;
	normalizeError?(error: unknown): Error;
}

type BridgeClose = Http1Bridge<unknown>["close"];
const activeBridges = new Set<{ close: BridgeClose }>();

export async function disposeHttp1Bridges(): Promise<void> {
	const bridges = Array.from(activeBridges);
	activeBridges.clear();
	await Promise.allSettled(bridges.map(bridge => bridge.close("dispose")));
}

/** Test seam for suites that provide their own bridge lifecycle. */
export function __resetHttp1Bridges(): void {
	activeBridges.clear();
}

type BridgeState =
	| { kind: "open"; phase: "receive" | "poll"; nextSeqno: bigint }
	| { kind: "closing"; reason: "success" | "fatal" | "abort" | "dispose"; error?: Error }
	| { kind: "closed"; error?: Error };

interface PendingAppend {
	seqno: bigint;
	data: Uint8Array;
	resolve: () => void;
	reject: (error: Error) => void;
}

/**
 * Adapts a request/response HTTP/1 Connect API to a bidirectional byte channel.
 * Protocol descriptors and message codecs stay with the provider through `createRpc`.
 */
export async function createHttp1Bridge<TMessage>(
	options: Http1BridgeOptions<TMessage>,
): Promise<Http1Bridge<TMessage>> {
	if (isTransportDisposed()) throw new Error("Transport disposed");

	// The controller must exist before proxy setup so close/disposal also aborts a
	// CONNECT tunnel that has not produced an agent socket yet.
	const bridgeAbort = new AbortController();
	const receiveSignal = options.signal ? AbortSignal.any([options.signal, bridgeAbort.signal]) : bridgeAbort.signal;
	const target = new URL(options.baseUrl);
	const proxyUrl = getProxyForUrl(options.provider, target);
	const agent = proxyUrl
		? createProxiedAgent(proxyUrl, options.baseUrl, { signal: receiveSignal, alpnProtocols: ["http/1.1"] })
		: undefined;
	const headerInterceptor: Interceptor = next => async request => {
		const headers = new Headers(request.header);
		for (const [name, value] of Object.entries(options.headers)) headers.set(name, value);
		return next({ ...request, header: headers });
	};
	const transport = createConnectTransport({
		baseUrl: options.baseUrl,
		httpVersion: "1.1",
		useBinaryFormat: true,
		interceptors: [headerInterceptor],
		nodeOptions: agent ? { agent } : undefined,
	});
	const rpc = options.createRpc(transport);
	const normalizeError = (error: unknown): Error =>
		options.normalizeError?.(error) ?? (error instanceof Error ? error : new Error(String(error)));

	let state: BridgeState = { kind: "open", phase: "receive", nextSeqno: 0n };
	const appendQueue: PendingAppend[] = [];
	const inFlight = new Set<Promise<void>>();
	const messageQueue: TMessage[] = [];
	let usedPollFallback = false;
	let sawMessage = false;
	let heartbeatTimer: NodeJS.Timeout | undefined;
	let waitResolve: (() => void) | undefined;
	const closed = Promise.withResolvers<void>();

	function notify(): void {
		const resolve = waitResolve;
		waitResolve = undefined;
		resolve?.();
	}

	function enqueue(message: TMessage): void {
		sawMessage = true;
		messageQueue.push(message);
		notify();
	}

	async function closeBridge(reason: "success" | "fatal" | "abort" | "dispose", error?: Error): Promise<void> {
		if (state.kind !== "open") return;
		const fatalError = reason === "fatal" ? (error ?? new Error("HTTP/1 bridge closed fatally")) : undefined;
		state = { kind: "closing", reason, error: fatalError };
		activeBridges.delete(bridge as Http1Bridge<unknown>);
		bridgeAbort.abort(fatalError ?? new Error(`HTTP/1 bridge closing: ${reason}`));
		agent?.destroy();
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
		const closeError = fatalError ?? new Error(`HTTP/1 bridge closing: ${reason}`);
		for (const pending of appendQueue) pending.reject(closeError);
		appendQueue.length = 0;
		closed.resolve();
		notify();
		await Promise.allSettled(Array.from(inFlight));
		state = { kind: "closed", error: fatalError };
		notify();
	}

	function startAppends(): void {
		while (state.kind === "open" && appendQueue.length > 0 && inFlight.size < MAX_IN_FLIGHT) {
			const pending = appendQueue.shift();
			if (!pending) return;
			const call = rpc.append(pending.seqno, pending.data, receiveSignal).then(
				() => {
					inFlight.delete(call);
					pending.resolve();
					startAppends();
				},
				(error: unknown) => {
					inFlight.delete(call);
					if (state.kind !== "open") {
						pending.resolve();
						return;
					}
					const fatal = normalizeError(error);
					pending.reject(fatal);
					for (const queued of appendQueue) queued.reject(fatal);
					appendQueue.length = 0;
					void closeBridge("fatal", fatal);
				},
			);
			inFlight.add(call);
		}
	}

	function send(data: Uint8Array): Promise<void> {
		if (state.kind !== "open") return Promise.reject(new Error("Cannot send after HTTP/1 bridge close"));
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		appendQueue.push({ seqno: state.nextSeqno, data, resolve, reject });
		state = { ...state, nextSeqno: state.nextSeqno + 1n };
		startAppends();
		return promise;
	}

	const messages: AsyncIterable<TMessage> = {
		[Symbol.asyncIterator]() {
			return {
				async next(): Promise<IteratorResult<TMessage>> {
					for (;;) {
						const message = messageQueue.shift();
						if (message !== undefined) return { value: message, done: false };
						if (state.kind === "closing" || state.kind === "closed") {
							if (state.error) throw state.error;
							return { value: undefined, done: true };
						}
						const wait = Promise.withResolvers<void>();
						waitResolve = wait.resolve;
						await Promise.race([wait.promise, closed.promise]);
						waitResolve = undefined;
					}
				},
				async return(): Promise<IteratorResult<TMessage>> {
					return { value: undefined, done: true };
				},
			};
		},
	};

	async function poll(): Promise<void> {
		let expectedSeq: bigint | undefined;
		let lastData: string | undefined;
		let acceptedDuplicate = false;
		try {
			for await (const frame of rpc.poll(receiveSignal)) {
				if (state.kind !== "open") return;
				if (expectedSeq === undefined) {
					expectedSeq = frame.seqno;
					lastData = frame.data;
				} else if (frame.seqno === expectedSeq) {
					if (acceptedDuplicate || frame.data !== lastData) {
						await closeBridge("fatal", new Error("HTTP/1 poll sequence repeated or changed"));
						return;
					}
					acceptedDuplicate = true;
					if (frame.eof) await closeBridge("success");
					continue;
				} else if (frame.seqno === expectedSeq + 1n) {
					expectedSeq = frame.seqno;
					lastData = frame.data;
					acceptedDuplicate = false;
				} else {
					await closeBridge("fatal", new Error(`HTTP/1 poll sequence violation at ${frame.seqno}`));
					return;
				}
				enqueue(rpc.decodePoll(frame.data));
				if (frame.eof) {
					await closeBridge("success");
					return;
				}
			}
			await closeBridge("success");
		} catch (error) {
			if (state.kind === "open") await closeBridge("fatal", normalizeError(error));
		}
	}

	async function receive(): Promise<void> {
		try {
			for await (const message of rpc.receive(receiveSignal)) {
				if (state.kind !== "open") return;
				enqueue(message);
			}
			if (state.kind !== "open") return;
			if (!sawMessage && !usedPollFallback) {
				usedPollFallback = true;
				state = { ...state, phase: "poll" };
				void poll();
				return;
			}
			await closeBridge("success");
		} catch (error) {
			if (state.kind !== "open") return;
			if (!sawMessage && !usedPollFallback && options.isRecoverableReceiveError?.(error)) {
				usedPollFallback = true;
				state = { ...state, phase: "poll" };
				void poll();
				return;
			}
			await closeBridge("fatal", normalizeError(error));
		}
	}

	const bridge: Http1Bridge<TMessage> = {
		messages,
		send,
		close: closeBridge as Http1Bridge<TMessage>["close"],
	};
	activeBridges.add(bridge as Http1Bridge<unknown>);
	void send(options.requestBytes).catch(() => undefined);
	if (options.heartbeatBytes) {
		heartbeatTimer = setInterval(() => {
			void send(options.heartbeatBytes as Uint8Array).catch(() => undefined);
		}, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
		heartbeatTimer.unref?.();
	}
	void receive();
	return bridge;
}

registerTransportDisposer("http1-bridges", disposeHttp1Bridges);
