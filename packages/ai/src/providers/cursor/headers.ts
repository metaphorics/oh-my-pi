import { CURSOR_DEFAULT_CLIENT_VERSION } from "@oh-my-pi/pi-catalog/discovery/cursor";
import { $env } from "@oh-my-pi/pi-utils";

/**
 * Catalog owns the sole committed client-version default. This module re-exports
 * it so provider request identity and model discovery consume one symbol; there
 * is no second default literal anywhere in the provider.
 */
export { CURSOR_DEFAULT_CLIENT_VERSION };

/**
 * Resolve the `x-cursor-client-version` header value.
 *
 * Precedence: explicit option override, then a non-empty `CURSOR_CLIENT_VERSION`
 * environment override, then the single catalog default. This is the only place
 * that reads the environment override, and it never introduces a fallback
 * literal of its own.
 */
export function resolveCursorClientVersion(optionVersion?: string): string {
	if (optionVersion && optionVersion.length > 0) return optionVersion;
	const envVersion = $env.CURSOR_CLIENT_VERSION;
	if (envVersion && envVersion.length > 0) return envVersion;
	return CURSOR_DEFAULT_CLIENT_VERSION;
}

export interface CursorHeaderParams {
	/** Bearer access token. */
	apiKey: string;
	/** Explicit per-request client-version override (highest precedence). */
	clientVersion?: string;
	/** Stable id shared by every attempt in one logical turn. */
	originalRequestId: string;
	/** Fresh id minted for this single transport attempt. */
	requestId: string;
	/** Cursor ghost mode; defaults to enabled. */
	ghostMode?: boolean;
	/** HTTP/1 agent RPCs additionally advertise streaming support. */
	http1?: boolean;
}

/**
 * Build the protected Cursor request-identity headers shared by every transport
 * (HTTP/2 Run, HTTP/1 BidiAppend/RunSSE/RunPoll, and unary GetServerConfig).
 * Transport-specific pseudo-headers (`:method`, `:path`, `content-type`,
 * `connect-protocol-version`, `te`) are added by the caller.
 */
export function buildCursorHeaders(params: CursorHeaderParams): Record<string, string> {
	const headers: Record<string, string> = {
		authorization: `Bearer ${params.apiKey}`,
		"x-ghost-mode": params.ghostMode === false ? "false" : "true",
		"x-cursor-client-type": "cli",
		"x-cursor-client-version": resolveCursorClientVersion(params.clientVersion),
		"x-original-request-id": params.originalRequestId,
		"x-request-id": params.requestId,
	};
	if (params.http1) {
		headers["x-cursor-streaming"] = "true";
	}
	return headers;
}
