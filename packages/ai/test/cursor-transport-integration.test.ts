import { afterEach, describe, expect, it } from "bun:test";
import * as http from "node:http";
import * as http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import { BidiAppendResponseSchema, BidiPollResponseSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/bidi_pb";
import { Http2Config } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/server_config_pb";
import { __evictH2PoolEntry, __getH2PoolStats, acquireH2Session } from "../src/providers/cursor/h2-pool";
import { __evictServerConfigEntry, selectMode } from "../src/providers/cursor/server-config";

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function textDeltaFrame(text: string): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) },
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function turnEndedFrame(): Buffer {
	return frameConnectMessage(toBinary(AgentServerMessageSchema, turnEndedMessage()));
}

function turnEndedMessage() {
	return create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
			}),
		},
	});
}

function connectErrorEndStreamFrame(code: string, message: string): Buffer {
	return frameConnectMessage(Buffer.from(JSON.stringify({ error: { code, message } }), "utf8"), 0x02);
}

let h2Server: http2.Http2Server | undefined;
let h1Server: http.Server | undefined;
let activeH2BaseUrl: string | undefined;
let activeH1BaseUrl: string | undefined;
const h2Sessions = new Set<http2.Http2Session>();
const requestPaths: string[] = [];
let handleH2Stream: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void = () => {};
let handleH1Request: (req: http.IncomingMessage, res: http.ServerResponse) => void = () => {};

async function startH2Server(): Promise<string> {
	h2Server = http2.createServer();
	h2Server.on("session", session => {
		h2Sessions.add(session);
		session.on("close", () => h2Sessions.delete(session));
	});
	h2Server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("data", () => {});
		stream.on("error", () => {});
		requestPaths.push(headers[":path"] ?? "");
		handleH2Stream(stream, headers);
	});
	const listening = Promise.withResolvers<void>();
	h2Server.once("error", listening.reject);
	h2Server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = h2Server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected http2 fixture server to bind a tcp port");
	}
	activeH2BaseUrl = `http://127.0.0.1:${address.port}`;
	return activeH2BaseUrl;
}

async function startH1Server(): Promise<string> {
	h1Server = http.createServer((req, res) => {
		requestPaths.push(req.url ?? "");
		handleH1Request(req, res);
	});
	const listening = Promise.withResolvers<void>();
	h1Server.once("error", listening.reject);
	h1Server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = h1Server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected http fixture server to bind a tcp port");
	}
	activeH1BaseUrl = `http://127.0.0.1:${address.port}`;
	return activeH1BaseUrl;
}

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-transport-fixture",
		name: "Cursor transport fixture",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});
}

const context: Context = {
	messages: [{ role: "user", content: "transport integration", timestamp: 1 }],
};
async function collect(
	model: Model<"cursor-agent">,
	options?: { signal?: AbortSignal; cursorUseHttp1ForAgent?: boolean; useHttp1ForAgent?: boolean },
): Promise<{ stopReason: string; text: string }> {
	const stream = streamCursor(model, context, {
		apiKey: "test-token",
		signal: options?.signal,
		cursorUseHttp1ForAgent: options?.cursorUseHttp1ForAgent,
		useHttp1ForAgent: options?.useHttp1ForAgent,
		providerRetryWait: async () => {},
	});
	const textDeltas: string[] = [];
	for await (const event of stream) {
		if (event.type === "text_delta") textDeltas.push(event.delta);
	}
	const result = await stream.result();
	return { stopReason: result.stopReason, text: textDeltas.join("") };
}

async function stopServers(): Promise<void> {
	for (const session of h2Sessions) session.destroy();
	h2Sessions.clear();
	if (h2Server) {
		const closing = h2Server;
		h2Server = undefined;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		closing.close(e => (e ? reject(e) : resolve()));
		await promise;
	}
	if (h1Server) {
		const closing = h1Server;
		h1Server = undefined;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		closing.close(e => (e ? reject(e) : resolve()));
		await promise;
	}
}

afterEach(async () => {
	requestPaths.length = 0;
	handleH2Stream = () => {};
	handleH1Request = () => {};
	if (activeH2BaseUrl) {
		__evictH2PoolEntry(activeH2BaseUrl);
		__evictServerConfigEntry(activeH2BaseUrl, "test-token");
		activeH2BaseUrl = undefined;
	}
	if (activeH1BaseUrl) {
		__evictH2PoolEntry(activeH1BaseUrl);
		__evictServerConfigEntry(activeH1BaseUrl, "test-token");
		activeH1BaseUrl = undefined;
	}
	await stopServers();
});

/** Fixture: handle GetServerConfig (404 → neutral) and Run (success) on H2. */
function h2SuccessHandler(): void {
	handleH2Stream = (stream, headers) => {
		const path = headers[":path"] ?? "";
		if (path.includes("GetServerConfig")) {
			stream.respond({ ":status": 404 });
			stream.end();
			return;
		}
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		stream.write(Buffer.concat([textDeltaFrame("ok"), turnEndedFrame()]));
		stream.end();
	};
}

describe("Cursor transport production integration", () => {
	it("uses the H2 pool for HTTP/2 attempts — pool entries created", async () => {
		const baseUrl = await startH2Server();
		h2SuccessHandler();
		const { stopReason } = await collect(makeModel(baseUrl));
		expect(stopReason).toBe("stop");
		const stats = __getH2PoolStats();
		expect(stats.poolCount).toBeGreaterThanOrEqual(1);
		expect(stats.retiringCount).toBe(0);
	});

	it("prefers mapped HTTP/1 after config discovery fails", async () => {
		const baseUrl = await startH1Server();
		let sawRunSSE = false;
		let sawBidiAppend = false;
		let sawGetServerConfig = false;
		let serverConfigOriginalRequestId: string | undefined;

		handleH1Request = (req, res) => {
			const url = req.url ?? "";
			if (url.includes("GetServerConfig")) {
				sawGetServerConfig = true;
				serverConfigOriginalRequestId = req.headers["x-original-request-id"] as string | undefined;
				res.writeHead(404, { "content-type": "application/json" });
				res.end();
				return;
			}
			if (url.includes("RunSSE")) {
				sawRunSSE = true;
				// The H1 bridge uses ConnectRPC which handles framing internally.
				// Just respond with a 200 and end — the bridge will get an error
				// from the incomplete stream, but the test only needs to prove
				// the H1 path was attempted.
				res.writeHead(200, { "content-type": "application/connect+json" });
				res.end();
				return;
			}
			if (url.includes("BidiAppend")) {
				sawBidiAppend = true;
				res.writeHead(200, { "content-type": "application/connect+json" });
				res.end();
				return;
			}
			res.writeHead(404);
			res.end();
		};

		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			useHttp1ForAgent: true,
			providerRetryWait: async () => {},
		});
		for await (const _event of stream) {
			// drain
		}
		await stream.result();

		// The config RPC was made over H1.
		expect(sawGetServerConfig).toBe(true);
		expect(serverConfigOriginalRequestId).toBeUndefined();
		// Either RunSSE or BidiAppend was attempted over H1.
		expect(sawRunSSE || sawBidiAppend).toBe(true);
		// H2 pool should NOT have been used for the agent traffic.
		const stats = __getH2PoolStats();
		expect(stats.poolCount).toBe(0);
	});

	it("fails the public stream when a queued turnEnded precedes an HTTP/1 poll sequence gap", async () => {
		const baseUrl = await startH1Server();
		const partial = toBinary(
			AgentServerMessageSchema,
			create(AgentServerMessageSchema, {
				message: {
					case: "interactionUpdate",
					value: create(InteractionUpdateSchema, {
						message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "partial" }) },
					}),
				},
			}),
		);
		const turnEnded = toBinary(AgentServerMessageSchema, turnEndedMessage());

		handleH1Request = (req, res) => {
			const url = req.url ?? "";
			if (url.includes("GetServerConfig")) {
				res.writeHead(404, { "content-type": "application/json" });
				res.end();
				return;
			}
			if (url.includes("BidiAppend")) {
				res.writeHead(200, { "content-type": "application/proto", Connection: "close" });
				res.end(toBinary(BidiAppendResponseSchema, create(BidiAppendResponseSchema, {})));
				return;
			}
			if (url.includes("RunSSE")) {
				res.writeHead(200, { "content-type": "application/connect+proto", Connection: "close" });
				res.end(connectErrorEndStreamFrame("unimplemented", "poll fallback"));
				return;
			}
			if (url.includes("RunPoll")) {
				const responses = [
					create(BidiPollResponseSchema, { seqno: 0n, data: Buffer.from(partial).toString("base64") }),
					create(BidiPollResponseSchema, { seqno: 1n, data: Buffer.from(turnEnded).toString("base64") }),
					create(BidiPollResponseSchema, { seqno: 3n, data: Buffer.from(partial).toString("base64") }),
				];
				res.writeHead(200, { "content-type": "application/connect+proto", Connection: "close" });
				res.end(
					Buffer.concat(
						responses.map(response => frameConnectMessage(toBinary(BidiPollResponseSchema, response))),
					),
				);
				return;
			}
			res.writeHead(404);
			res.end();
		};

		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			useHttp1ForAgent: true,
			providerRetryWait: async () => {},
		});
		const eventTypes: string[] = [];
		for await (const event of stream) eventTypes.push(event.type);
		const result = await stream.result();

		expect(eventTypes[0]).toBe("start");
		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Cursor HTTP/1 poll sequence violation: gap");
	});

	it("server-force override wins over local preference", () => {
		expect(selectMode(Http2Config.FORCE_ALL_ENABLED, true)).toBe("http2");
		expect(selectMode(Http2Config.FORCE_ALL_DISABLED, false)).toBe("http1");
		expect(selectMode(Http2Config.FORCE_BIDI_DISABLED, true)).toBe("http1");
		expect(selectMode(Http2Config.FORCE_BIDI_ENABLED, false)).toBe("http2");
		expect(selectMode(Http2Config.UNSPECIFIED, false)).toBe("http2");
		expect(selectMode(Http2Config.UNSPECIFIED, true)).toBe("http1");
	});

	it("uses custom endpoint URL as-is for non-production base URLs", async () => {
		const baseUrl = await startH2Server();
		h2SuccessHandler();
		const { stopReason } = await collect(makeModel(baseUrl));
		expect(stopReason).toBe("stop");
		expect(requestPaths.some(p => p.includes("/agent.v1.AgentService/Run"))).toBe(true);
	});

	it("releases H2 lease on abort — no lingering retiring managers", async () => {
		const baseUrl = await startH2Server();
		let serverStream: http2.ServerHttp2Stream | undefined;
		const streamOpened = Promise.withResolvers<void>();
		handleH2Stream = (stream, headers) => {
			const path = headers[":path"] ?? "";
			if (path.includes("GetServerConfig")) {
				stream.respond({ ":status": 404 });
				stream.end();
				return;
			}
			serverStream = stream;
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			streamOpened.resolve();
		};

		const controller = new AbortController();
		const cursorStream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			signal: controller.signal,
			providerRetryWait: async () => {},
		});

		const consuming = (async () => {
			for await (const _event of cursorStream) {
				// drain
			}
		})();

		await streamOpened.promise;
		controller.abort();
		await consuming.catch(() => {});
		const result = await cursorStream.result();
		serverStream?.close();

		expect(result.stopReason).toBe("aborted");
		const stats = __getH2PoolStats();
		expect(stats.retiringCount).toBe(0);
	});

	it("acquireH2Session returns a usable lease through the pool", async () => {
		const baseUrl = await startH2Server();
		h2SuccessHandler();

		const lease = await acquireH2Session(baseUrl, "cursor");
		expect(lease.manager).toBeDefined();
		expect(typeof lease.release).toBe("function");
		lease.release();

		const stats = __getH2PoolStats();
		expect(stats.poolCount).toBeGreaterThanOrEqual(1);
		expect(stats.retiringCount).toBe(0);
	});

	it("routes agent traffic through the H2 pool, not a direct http2.connect bypass", async () => {
		const baseUrl = await startH2Server();
		h2SuccessHandler();

		const { stopReason } = await collect(makeModel(baseUrl));
		expect(stopReason).toBe("stop");

		// The fixture received the Run RPC over a real H2 session — a bypass
		// that never connected would leave requestPaths empty.
		expect(requestPaths.some(p => p.includes("/agent.v1.AgentService/Run"))).toBe(true);

		// The pool owns a healthy entry for this origin — a direct
		// http2.connect bypass would create no pool entry (poolCount === 0).
		const stats = __getH2PoolStats();
		expect(stats.poolCount).toBeGreaterThanOrEqual(1);
		// All leases released; no managers stuck retiring.
		expect(stats.retiringCount).toBe(0);
	});
});
