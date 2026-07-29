import { Code, ConnectError } from "@connectrpc/connect";
import * as AIError from "../error";

const TRANSIENT_CONNECT_CODES: Record<number, true> = {
	[Code.Canceled]: true,
	[Code.Unknown]: true,
	[Code.DeadlineExceeded]: true,
	[Code.Aborted]: true,
	[Code.Internal]: true,
	[Code.Unavailable]: true,
	[Code.DataLoss]: true,
};

const TRANSIENT_SYSTEM_CODES: Record<string, true> = {
	ECONNABORTED: true,
	ECONNREFUSED: true,
	ECONNRESET: true,
	EHOSTUNREACH: true,
	ENETDOWN: true,
	ENETUNREACH: true,
	ENOTFOUND: true,
	EPIPE: true,
	ERR_HTTP2_GOAWAY_SESSION: true,
	ERR_HTTP2_INVALID_SESSION: true,
	ERR_HTTP2_STREAM_CANCEL: true,
	ERR_HTTP2_STREAM_ERROR: true,
	ETIMEDOUT: true,
};

const TRANSIENT_MESSAGE_PATTERN =
	/connection (?:closed|error|refused|reset)|fetch failed|h2 is not supported|network error|other side closed|reset before headers|socket hang up|stream (?:closed|error)|timed? ?out|upstream (?:connect|request) failed/i;

export function normalizeConnectAuthError(
	error: unknown,
	createCredentialError: (message: string, status: 401 | 403) => Error,
): Error {
	if (error instanceof ConnectError) {
		if (error.code === Code.Unauthenticated) return createCredentialError(error.message, 401);
		if (error.code === Code.PermissionDenied) return createCredentialError(error.message, 403);
	}
	return error instanceof Error ? error : new Error(String(error));
}

export function isTransientTransportError(error: unknown): boolean {
	if (error instanceof AIError.AbortError || error instanceof AIError.ValidationError) return false;
	if (AIError.isUsageLimit(error) || AIError.is(AIError.classify(error), AIError.Flag.AuthFailed)) return false;
	if (error instanceof ConnectError) return TRANSIENT_CONNECT_CODES[error.code] === true;

	const status = AIError.status(error);
	if (status !== undefined) return status === 408 || status === 425 || status >= 500;

	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === "string" && TRANSIENT_SYSTEM_CODES[code]) return true;
	const message = error instanceof Error ? error.message : String(error);
	return TRANSIENT_MESSAGE_PATTERN.test(message);
}
