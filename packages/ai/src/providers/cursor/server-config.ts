import { create } from "@bufbuild/protobuf";
import type { Interceptor } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { type GetServerConfigResponse, Http2Config } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/server_config_pb";
import * as AIError from "../../error";
import { isTransportDisposed, registerTransportDisposer } from "../../transport";
import { createProxiedAgent, getProxyForUrl } from "../../utils/proxy";
import { buildCursorHeaders } from "./headers";
import { normalizeCursorConnectError } from "./http1";
import { CursorServerConfigService, GetServerConfigRequestSchema } from "./transport-descriptors";

/**
 * Server-config discovery cache.
 *
 * Keyed by normalized base URL and hashed credential; credential text is
 * never retained. Auth failures evict the entry before outer credential
 * rotation. Caller abort only stops that caller's wait. Disposal aborts
 * pending fetches and clears cached results.
 */

type ConfigState =
	| { kind: "fetching"; controller: AbortController; promise: Promise<ServerConfigResult> }
	| { kind: "ready"; result: ServerConfigResult };

export interface ServerConfigResult {
	/** Server-forced HTTP/2 policy, or UNSPECIFIED if discovery failed. */
	http2Config: Http2Config;
	/** Agent URL config, or undefined if not provided. */
	agentUrlConfig?: { agentUrl: string; agentnUrl: string };
}

interface CacheEntry {
	state: ConfigState;
}

const configCache = new Map<string, CacheEntry>();

/** Upper bound on a single server-config discovery round trip. */
const DISCOVERY_TIMEOUT_MS = 10_000;

function configKey(baseUrl: string, apiKey: string): string {
	const url = new URL(baseUrl);
	const normalized = `${url.origin}${url.pathname.replace(/\/$/, "")}`;
	return `${normalized}:${Bun.hash(apiKey)}`;
}

/**
 * Resolve transport mode for a Cursor turn.
 *
 * Force policy from the server outranks the local preference. If discovery
 * fails for ordinary reasons (network, timeout), cache neutral/UNSPECIFIED
 * policy so the local preference wins. Auth failures are propagated, never
 * converted to neutral.
 */
export type CursorTransportMode = "http2" | "http1";

export interface ResolveTransportModeOptions {
	baseUrl: string;
	apiKey: string;
	provider: string;
	/** Local preference from providers.cursor.useHttp1ForAgent. */
	useHttp1ForAgent: boolean;
	clientVersion?: string;
	originalRequestId: string;
	signal?: AbortSignal;
}

export async function resolveCursorTransportMode(
	opts: ResolveTransportModeOptions,
): Promise<{ mode: CursorTransportMode; agentUrlConfig?: { agentUrl: string; agentnUrl: string } }> {
	if (isTransportDisposed()) {
		throw new Error("Transport disposed");
	}
	const key = configKey(opts.baseUrl, opts.apiKey);
	let entry = configCache.get(key);

	if (!entry) {
		// Start a fresh fetch. The shared fetch promise settles on its own
		// and updates the cache; callers race against their own signal.
		const controller = new AbortController();
		const fetchPromise = fetchServerConfig(opts, controller.signal).then(
			(result): ServerConfigResult => {
				// Cache the result when the fetch itself settles.
				const current = configCache.get(key);
				if (current && current.state.kind === "fetching") {
					current.state = { kind: "ready", result };
				}
				return result;
			},
			(error: unknown): ServerConfigResult => {
				const normalized = normalizeCursorConnectError(error);
				if (normalized instanceof AIError.CursorCredentialError) {
					configCache.delete(key);
					throw normalized;
				}
				// Ordinary failure: cache neutral result.
				const neutral: ServerConfigResult = { http2Config: Http2Config.UNSPECIFIED };
				const current = configCache.get(key);
				if (current && current.state.kind === "fetching") {
					current.state = { kind: "ready", result: neutral };
				}
				return neutral;
			},
		);
		entry = { state: { kind: "fetching", controller, promise: fetchPromise } };
		configCache.set(key, entry);
	}

	let result: ServerConfigResult;
	if (entry.state.kind === "fetching") {
		// Race the shared fetch against the caller's signal. A caller abort
		// does NOT update the cache — the shared fetch continues for other
		// callers.
		result = await raceFetchWithSignal(entry.state.promise, opts.signal);
	} else {
		result = entry.state.result;
	}

	return {
		mode: selectMode(result.http2Config, opts.useHttp1ForAgent),
		agentUrlConfig: result.agentUrlConfig,
	};
}

export function selectMode(http2Config: Http2Config, useHttp1ForAgent: boolean): CursorTransportMode {
	switch (http2Config) {
		case Http2Config.FORCE_ALL_DISABLED:
		case Http2Config.FORCE_BIDI_DISABLED:
			return "http1";
		case Http2Config.FORCE_ALL_ENABLED:
		case Http2Config.FORCE_BIDI_ENABLED:
			return "http2";
		default:
			return useHttp1ForAgent ? "http1" : "http2";
	}
}

async function fetchServerConfig(
	opts: ResolveTransportModeOptions,
	controllerSignal: AbortSignal,
): Promise<ServerConfigResult> {
	const proxyUrl = getProxyForUrl(opts.provider, new URL(opts.baseUrl));
	const agent = proxyUrl
		? createProxiedAgent(proxyUrl, opts.baseUrl, { signal: controllerSignal, alpnProtocols: ["http/1.1"] })
		: undefined;

	const headerInterceptor: Interceptor = next => async req => {
		const headers = new Headers(req.header);
		for (const [k, v] of Object.entries(
			buildCursorHeaders({
				apiKey: opts.apiKey,
				clientVersion: opts.clientVersion,
				originalRequestId: opts.originalRequestId,
				requestId: crypto.randomUUID(),
			}),
		)) {
			headers.set(k, v);
		}
		return next({ ...req, header: headers });
	};

	try {
		const transport = createConnectTransport({
			baseUrl: opts.baseUrl,
			httpVersion: "1.1",
			useBinaryFormat: true,
			interceptors: [headerInterceptor],
			nodeOptions: agent ? { agent } : undefined,
		});

		const client = createClient(CursorServerConfigService, transport);
		// Bound discovery: a server that accepts the connection and never
		// answers would otherwise pin every concurrent caller on the shared
		// cached fetch promise. On timeout the caller's neutral fallback wins.
		const response: GetServerConfigResponse = await client.getServerConfig(create(GetServerConfigRequestSchema, {}), {
			signal: AbortSignal.any([controllerSignal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]),
		});
		return {
			http2Config: response.http2Config,
			agentUrlConfig: response.agentUrlConfig
				? { agentUrl: response.agentUrlConfig.agentUrl, agentnUrl: response.agentUrlConfig.agentnUrl }
				: undefined,
		};
	} finally {
		agent?.destroy();
	}
}

function raceFetchWithSignal(
	promise: Promise<ServerConfigResult>,
	signal: AbortSignal | undefined,
): Promise<ServerConfigResult> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new AIError.AbortError("Aborted before config fetch"));
	const { promise: result, resolve, reject } = Promise.withResolvers<ServerConfigResult>();
	const onAbort = (): void => {
		signal.removeEventListener("abort", onAbort);
		reject(new AIError.AbortError("Aborted during config fetch"));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	promise.then(
		value => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		},
		error => {
			signal.removeEventListener("abort", onAbort);
			reject(error);
		},
	);
	return result;
}

/**
 * Evict a cache entry on auth failure. Called before credential rotation.
 */
export function evictServerConfig(baseUrl: string, apiKey: string): void {
	const key = configKey(baseUrl, apiKey);
	configCache.delete(key);
}

/**
 * Dispose all config cache entries and their owned resources.
 */
export async function disposeServerConfigCache(): Promise<void> {
	const entries = Array.from(configCache.values());
	configCache.clear();
	const promises: Promise<unknown>[] = [];
	for (const entry of entries) {
		if (entry.state.kind === "fetching") {
			entry.state.controller.abort(new Error("Config cache disposed"));
			promises.push(entry.state.promise.catch(() => undefined));
		}
	}
	await Promise.allSettled(promises);
}
/** Test-only: reset cache state. */
export function __resetServerConfigCache(): void {
	configCache.clear();
}

/**
 * Test-only: evict a single server config entry by its URL and API key.
 * Leaves every other cached entry untouched so concurrent test files using
 * different endpoints/credentials are unaffected.
 */
export function __evictServerConfigEntry(baseUrl: string, apiKey: string): void {
	const key = configKey(baseUrl, apiKey);
	const entry = configCache.get(key);
	if (entry?.state.kind === "fetching") {
		entry.state.controller.abort(new Error("Test evicted server config"));
	}
	configCache.delete(key);
}

registerTransportDisposer("cursor-server-config", disposeServerConfigCache);
