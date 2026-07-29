import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { Client, Interceptor } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import type { AgentServerMessage } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import { ClientHeartbeatSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import type { BidiRequestId } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/bidi_pb";
import * as AIError from "../../error";
import { createProxiedAgent, getProxyForProvider, shouldBypassProxy } from "../../utils/proxy";
import { buildCursorHeaders } from "./headers";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	BidiAppendRequestSchema,
	BidiPollRequestSchema,
	BidiRequestIdSchema,
	CursorAgentService,
	CursorBidiService,
} from "./transport-descriptors";
import { isCursorTransportDisposed } from "./transport-lifecycle";

const activeH1Bridges = new Set<CursorHttp1Bridge>();

export async function disposeH1Bridges(): Promise<void> {
	const bridges = Array.from(activeH1Bridges);
	activeH1Bridges.clear();
	await Promise.allSettled(bridges.map(b => b.close("dispose")));
}

export function __resetH1Bridges(): void {
	activeH1Bridges.clear();
}

/**
 * HTTP/1 bridge for Cursor's bidi-streaming Run RPC.
 *
 * Maps the BiDiStreaming Run method to ServerStreaming RunSSE + unary
 * BidiAppend, with an optional RunPoll fallback for recoverable SSE errors.
 *
 * State machine: Open(SSE) → optionally Open(Poll) → Closing(success|fatal|abort|dispose) → Closed.
 * Owns a BidiAppend queue, ≤16 FIFO-started in-flight appends, inbound iterator,
 * heartbeat timer, one turn AbortController, and H1 proxy agent.
 */

const MAX_IN_FLIGHT = 16;
const HEARTBEAT_INTERVAL_MS = 5000;

type BridgeState =
	| { kind: "open"; phase: "sse" | "poll"; nextSeqno: bigint }
	| { kind: "closing"; reason: "success" | "fatal" | "abort" | "dispose"; error?: Error }
	| { kind: "closed"; error?: Error };

interface PendingAppend {
	seqno: bigint;
	data: Uint8Array;
	resolve: () => void;
	reject: (error: Error) => void;
}

export interface CursorHttp1Bridge {
	readonly messages: AsyncIterable<AgentServerMessage>;
	send(data: Uint8Array): Promise<void>;
	close(reason: "success" | "fatal" | "abort" | "dispose", error?: Error): Promise<void>;
}

export async function createCursorHttp1Bridge(opts: {
	baseUrl: string;
	apiKey: string;
	provider: string;
	clientVersion?: string;
	originalRequestId: string;
	requestId: string;
	ghostMode?: boolean;
	requestBytes: Uint8Array;
	signal?: AbortSignal;
}): Promise<CursorHttp1Bridge> {
	if (isCursorTransportDisposed()) {
		throw new Error("Transport disposed");
	}

	const proxyUrl = shouldBypassProxy(new URL(opts.baseUrl))
		? undefined
		: getProxyForProvider(opts.provider ?? "cursor");
	const agent = proxyUrl
		? createProxiedAgent(proxyUrl, opts.baseUrl, { signal: opts.signal, alpnProtocols: ["http/1.1"] })
		: undefined;

	const headerInterceptor: Interceptor = next => async req => {
		const headers = new Headers(req.header);
		for (const [k, v] of Object.entries(
			buildCursorHeaders({
				apiKey: opts.apiKey,
				clientVersion: opts.clientVersion,
				originalRequestId: opts.originalRequestId,
				requestId: opts.requestId,
				ghostMode: opts.ghostMode,
				http1: true,
			}),
		)) {
			headers.set(k, v);
		}
		return next({ ...req, header: headers });
	};

	const transport = createConnectTransport({
		baseUrl: opts.baseUrl,
		httpVersion: "1.1",
		useBinaryFormat: true,
		interceptors: [headerInterceptor],
		nodeOptions: agent ? { agent } : undefined,
	});

	const bidiRequestId = create(BidiRequestIdSchema, { requestId: opts.requestId });
	const agentClient = createClient(CursorAgentService, transport);
	const bidiClient = createClient(CursorBidiService, transport);

	let state: BridgeState = { kind: "open", phase: "sse", nextSeqno: 0n };
	const appendQueue: PendingAppend[] = [];
	const inFlight: Set<Promise<void>> = new Set();
	let pollUsed = false;
	let sawDecodedServerMessage = false;
	let heartbeatTimer: NodeJS.Timeout | undefined;
	// Bridge-owned controller so dispose/fatal/success close cancels the receive
	// stream even when the caller signal is still open.
	const bridgeAbort = new AbortController();
	const receiveSignal = opts.signal ? AbortSignal.any([opts.signal, bridgeAbort.signal]) : bridgeAbort.signal;

	// Per-wait notification: resolves when a new message is enqueued or on close.
	let waitResolve: (() => void) | undefined;
	const messageQueue: AgentServerMessage[] = [];
	const { promise: closedSignal, resolve: resolveClosed } = Promise.withResolvers<void>();

	function notifyWaiter(): void {
		if (waitResolve) {
			const resolve = waitResolve;
			waitResolve = undefined;
			resolve();
		}
	}

	function enqueueMessage(msg: AgentServerMessage): void {
		sawDecodedServerMessage = true;
		messageQueue.push(msg);
		notifyWaiter();
	}

	async function closeBridge(reason: "success" | "fatal" | "abort" | "dispose", error?: Error): Promise<void> {
		if (state.kind === "closed" || state.kind === "closing") return;
		state = { kind: "closing", reason, error: reason === "fatal" ? error : undefined };
		activeH1Bridges.delete(bridge);
		// Cancel the receive stream on every close path. The SSE/poll catch
		// ignores abort once state is no longer open, so a success close does
		// not surface a spurious fatal error on the message stream.
		if (!bridgeAbort.signal.aborted) {
			bridgeAbort.abort(error ?? new Error(`Bridge closing: ${reason}`));
		}
		agent?.destroy();

		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}

		// Reject all pending appends that haven't started.
		const abortError = new Error(`Bridge closing: ${reason}`);
		for (const pending of appendQueue) {
			pending.reject(abortError);
		}
		appendQueue.length = 0;

		// Await all in-flight appends.
		const inFlightPromises = Array.from(inFlight);
		inFlight.clear();

		// Wake the message iterator.
		resolveClosed();
		notifyWaiter();

		await Promise.allSettled(inFlightPromises);
		state = { kind: "closed", error: state.error };
	}

	async function sendAppend(data: Uint8Array): Promise<void> {
		if (state.kind !== "open") {
			throw new Error("Cannot send after bridge close");
		}

		const seqno = state.nextSeqno;
		state = { ...state, nextSeqno: state.nextSeqno + 1n };

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const pending: PendingAppend = { seqno, data, resolve, reject };
		appendQueue.push(pending);

		startAppends();

		return promise;
	}

	function startAppends(): void {
		while (appendQueue.length > 0 && inFlight.size < MAX_IN_FLIGHT && state.kind === "open") {
			const pending = appendQueue.shift();
			if (!pending) break;

			const appendRequest = create(BidiAppendRequestSchema, {
				requestId: bidiRequestId,
				appendSeqno: pending.seqno,
				dataBinary: pending.data,
			});

			const inFlightPromise = bidiClient
				.bidiAppend(appendRequest, { signal: receiveSignal })
				.then(() => {
					inFlight.delete(inFlightPromise);
					pending.resolve();
					startAppends();
				})
				.catch((error: unknown) => {
					inFlight.delete(inFlightPromise);
					if (state.kind === "closing" || state.kind === "closed") {
						// Close-induced errors are not fatal.
						pending.resolve();
						return;
					}
					// Fatal append failure while open: seal queue, abort others.
					const err = error instanceof Error ? error : new Error(String(error));
					pending.reject(err);
					for (const p of appendQueue) {
						p.reject(new Error("Append failure sealed the queue"));
					}
					appendQueue.length = 0;
					void closeBridge("fatal", connectAuthToCursorCredentialError(error) ?? err);
				});

			inFlight.add(inFlightPromise);
		}
	}

	// Start SSE consumption and append the initial request.
	const sseIterable = agentClient.runSSE(create(BidiRequestIdSchema, { requestId: opts.requestId }), {
		signal: receiveSignal,
	});

	// Append initial request bytes at seqno 0n.
	void sendAppend(opts.requestBytes).catch(() => {
		// Initial append failure is fatal; handled by sendAppend's rejection.
	});

	// Start heartbeat.
	heartbeatTimer = setInterval(() => {
		const heartbeat = create(AgentClientMessageSchema, {
			message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
		});
		void sendAppend(toBinary(AgentClientMessageSchema, heartbeat)).catch(() => {
			// Heartbeat send failure is non-fatal.
		});
	}, HEARTBEAT_INTERVAL_MS);
	heartbeatTimer.unref?.();

	// Create the async iterable for server messages.
	const messageIterator: AsyncIterable<AgentServerMessage> = {
		[Symbol.asyncIterator]() {
			return {
				async next(): Promise<IteratorResult<AgentServerMessage>> {
					for (;;) {
						if (messageQueue.length > 0) {
							const msg = messageQueue.shift();
							if (msg !== undefined) {
								return { value: msg, done: false };
							}
						}
						if (state.kind === "closed" || state.kind === "closing") {
							// A fatal close propagates the underlying transport/SSE
							// error to the outer consumer so the retry supervisor
							// can classify and replay it; a clean close ends the
							// iterator normally.
							if (state.error) throw state.error;
							return { value: undefined, done: true };
						}
						// Wait for a message or close notification.
						const { promise: wait, resolve } = Promise.withResolvers<void>();
						waitResolve = resolve;
						await Promise.race([wait, closedSignal]);
						waitResolve = undefined;
					}
				},
				async return(): Promise<IteratorResult<AgentServerMessage>> {
					return { value: undefined, done: true };
				},
				async throw(error?: unknown): Promise<IteratorResult<AgentServerMessage>> {
					throw error;
				},
			};
		},
	};

	// Consume the SSE stream in the background.
	(async () => {
		try {
			for await (const _rawMsg of sseIterable) {
				if (state.kind !== "open") break;
				// The server-streaming response yields AgentServerMessage instances.
				const decoded = _rawMsg as AgentServerMessage;
				enqueueMessage(decoded);
			}
			// Normal SSE stream end: close successfully if still open (or poll fallback if clean EOF before first decoded message).
			if (state.kind === "open") {
				if (!sawDecodedServerMessage && !pollUsed) {
					pollUsed = true;
					const currentSeqno = state.kind === "open" ? state.nextSeqno : 0n;
					state = { kind: "open", phase: "poll", nextSeqno: currentSeqno };
					void startPollFallback(
						agentClient,
						bidiRequestId,
						{ signal: receiveSignal },
						enqueueMessage,
						closeBridge,
						() => state.kind === "open",
					);
					return;
				}
				await closeBridge("success");
			}
		} catch (error) {
			if (state.kind !== "open") return;

			// Check for recoverable SSE errors before first decoded message.
			if (!sawDecodedServerMessage && !pollUsed && isRecoverableSSEError(error)) {
				pollUsed = true;
				const currentSeqno = state.kind === "open" ? state.nextSeqno : 0n;
				state = { kind: "open", phase: "poll", nextSeqno: currentSeqno };
				void startPollFallback(
					agentClient,
					bidiRequestId,
					{ signal: receiveSignal },
					enqueueMessage,
					closeBridge,
					() => state.kind === "open",
				);
				return;
			}
			// Fatal inbound failure: seal both directions and propagate the
			// error so the outer retry supervisor can classify it. Auth Connect
			// codes become CursorCredentialError so credential rotation triggers.
			const fatal =
				connectAuthToCursorCredentialError(error) ?? (error instanceof Error ? error : new Error(String(error)));
			void closeBridge("fatal", fatal);
		}
	})();
	const bridge: CursorHttp1Bridge = {
		messages: messageIterator,
		send: sendAppend,
		close: closeBridge,
	};
	activeH1Bridges.add(bridge);
	return bridge;
}

/** Map Connect auth codes to CursorCredentialError for credential rotation. */
function connectAuthToCursorCredentialError(error: unknown): AIError.CursorCredentialError | undefined {
	if (!(error instanceof ConnectError)) return undefined;
	if (error.code === Code.Unauthenticated) {
		return new AIError.CursorCredentialError(error.message, 401);
	}
	if (error.code === Code.PermissionDenied) {
		return new AIError.CursorCredentialError(error.message, 403);
	}
	return undefined;
}

function isRecoverableSSEError(error: unknown): boolean {
	if (error instanceof ConnectError) {
		if (error.code === Code.NotFound || error.code === Code.Unimplemented) {
			return true;
		}
	}
	const message = error instanceof Error ? error.message : String(error);
	return /\b404\b|\b501\b|unimplemented|eof|premature close/i.test(message);
}
async function startPollFallback(
	agentClient: Client<typeof CursorAgentService>,
	bidiRequestId: BidiRequestId,
	opts: { signal?: AbortSignal },
	enqueueMessage: (msg: AgentServerMessage) => void,
	closeBridge: (reason: "success" | "fatal" | "abort" | "dispose", error?: Error) => Promise<void>,
	isOpen: () => boolean,
): Promise<void> {
	const pollRequest = create(BidiPollRequestSchema, {
		requestId: bidiRequestId,
		startRequest: true,
	});

	let expectedSeq: bigint | undefined;
	let lastSeqData: string | undefined;
	let duplicateCount = 0;
	const sequenceViolation = (detail: string): AIError.ProviderResponseError =>
		new AIError.ProviderResponseError(`Cursor HTTP/1 poll sequence violation: ${detail}`, { kind: "envelope" });

	try {
		const pollIterable = agentClient.runPoll(pollRequest, { signal: opts.signal });
		for await (const pollResponse of pollIterable) {
			if (!isOpen()) return;

			if (expectedSeq === undefined) {
				expectedSeq = pollResponse.seqno;
				lastSeqData = pollResponse.data;
				duplicateCount = 0;
			} else if (pollResponse.seqno === expectedSeq) {
				if (duplicateCount >= 1) {
					await closeBridge("fatal", sequenceViolation(`second consecutive duplicate at ${pollResponse.seqno}`));
					return;
				}
				if (pollResponse.data !== lastSeqData) {
					await closeBridge("fatal", sequenceViolation(`altered duplicate at ${pollResponse.seqno}`));
					return;
				}
				// First retransmit of an already-delivered frame: tolerate it,
				// but discard the payload. Re-enqueuing would render text twice
				// and run an exec frame twice.
				duplicateCount = 1;
				if (pollResponse.eof) {
					await closeBridge("success");
					return;
				}
				pollRequest.startRequest = false;
				continue;
			} else if (pollResponse.seqno === expectedSeq + 1n) {
				expectedSeq = pollResponse.seqno;
				lastSeqData = pollResponse.data;
				duplicateCount = 0;
			} else {
				// Gaps and regressions are terminal protocol corruption.
				const violation = pollResponse.seqno > expectedSeq ? "gap" : "regression";
				await closeBridge(
					"fatal",
					sequenceViolation(`${violation}: expected ${expectedSeq + 1n}, received ${pollResponse.seqno}`),
				);
				return;
			}

			const dataBytes = Buffer.from(pollResponse.data, "base64");
			const decoded = fromBinary(AgentServerMessageSchema, dataBytes);
			enqueueMessage(decoded);

			if (pollResponse.eof) {
				await closeBridge("success");
				return;
			}

			pollRequest.startRequest = false;
		}
		// Stream ended without eof: still close successfully.
		await closeBridge("success");
	} catch (error) {
		await closeBridge("fatal", error instanceof Error ? error : new Error(String(error)));
	}
}
