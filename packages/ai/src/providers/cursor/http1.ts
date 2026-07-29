import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import type { AgentServerMessage } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import { ClientHeartbeatSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import * as AIError from "../../error";
import { createHttp1Bridge, type Http1Bridge, type Http1BridgeRpc, normalizeConnectAuthError } from "../../transport";
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

export type CursorHttp1Bridge = Http1Bridge<AgentServerMessage>;

export function normalizeCursorConnectError(error: unknown): Error {
	return normalizeConnectAuthError(error, (message, status) => new AIError.CursorCredentialError(message, status));
}

export async function createCursorHttp1Bridge(options: {
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
	const requestId = create(BidiRequestIdSchema, { requestId: options.requestId });
	const heartbeat = create(AgentClientMessageSchema, {
		message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
	});
	return createHttp1Bridge({
		baseUrl: options.baseUrl,
		provider: options.provider,
		headers: buildCursorHeaders({
			apiKey: options.apiKey,
			clientVersion: options.clientVersion,
			originalRequestId: options.originalRequestId,
			requestId: options.requestId,
			ghostMode: options.ghostMode,
			http1: true,
		}),
		requestBytes: options.requestBytes,
		heartbeatBytes: toBinary(AgentClientMessageSchema, heartbeat),
		signal: options.signal,
		normalizeError: normalizeCursorConnectError,
		isRecoverableReceiveError(error) {
			if (error instanceof ConnectError && (error.code === Code.NotFound || error.code === Code.Unimplemented)) {
				return true;
			}
			const message = error instanceof Error ? error.message : String(error);
			return /\b404\b|\b501\b|unimplemented|eof|premature close/i.test(message);
		},
		createRpc(transport: Transport): Http1BridgeRpc<AgentServerMessage> {
			const agentClient = createClient(CursorAgentService, transport);
			const bidiClient = createClient(CursorBidiService, transport);
			return {
				append(seqno, data, signal) {
					return bidiClient
						.bidiAppend(create(BidiAppendRequestSchema, { requestId, appendSeqno: seqno, dataBinary: data }), {
							signal,
						})
						.then(() => undefined);
				},
				receive(signal) {
					return agentClient.runSSE(requestId, { signal });
				},
				async *poll(signal) {
					const request = create(BidiPollRequestSchema, { requestId, startRequest: true });
					for await (const response of agentClient.runPoll(request, { signal })) {
						yield { seqno: response.seqno, data: response.data, eof: response.eof };
						request.startRequest = false;
					}
				},
				decodePoll(data) {
					return fromBinary(AgentServerMessageSchema, Buffer.from(data, "base64"));
				},
			};
		},
	});
}
