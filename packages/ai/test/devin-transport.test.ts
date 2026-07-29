import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create, toBinary } from "@bufbuild/protobuf";
import { CONNECT_END_STREAM_FLAG, disposeH2Pool, encodeConnectFrame } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { GetChatMessageResponseSchema } from "@oh-my-pi/pi-catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
let h2Server: http2.Http2Server;
let h2BaseUrl = "";
let respond: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => Promise<void> | void;

function listen(server: http2.Http2Server): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address() as AddressInfo;
		resolve(`http://127.0.0.1:${address.port}`);
	});
	return promise;
}

function close(server: http2.Http2Server): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.close(error => (error ? reject(error) : resolve()));
	return promise;
}

function responseFrame(text: string): Uint8Array {
	return encodeConnectFrame(
		toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, { deltaText: text })),
	);
}

function writeChunk(stream: http2.ServerHttp2Stream, chunk: Uint8Array): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	stream.write(chunk, () => resolve());
	return promise;
}

beforeAll(async () => {
	h2Server = http2.createServer();
	h2Server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("data", () => undefined);
		void Promise.resolve(respond(stream, headers)).catch(error => stream.destroy(error));
	});
	h2BaseUrl = await listen(h2Server);
});

afterAll(async () => {
	await disposeH2Pool();
	await close(h2Server);
});

function model(): Model<"devin-agent"> {
	return buildModel({
		id: "devin-transport-test",
		name: "Devin Transport Test",
		api: "devin-agent",
		provider: "devin",
		baseUrl: h2BaseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});
}

describe("streamDevin shared HTTP/2 transport", () => {
	it("decodes a Connect frame split across HTTP/2 chunks", async () => {
		respond = async (stream, headers) => {
			expect(headers[":path"]).toBe("/exa.api_server_pb.ApiServerService/GetChatMessage");
			expect(headers.te).toBe("trailers");
			expect(headers.authorization).toBe("Basic devin-session-token$token");
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			const frame = responseFrame("split frame");
			const terminal = encodeConnectFrame(new Uint8Array(0), CONNECT_END_STREAM_FLAG);
			await writeChunk(stream, frame.subarray(0, 2));
			await writeChunk(stream, frame.subarray(2, 7));
			stream.end(Buffer.concat([frame.subarray(7), terminal]));
		};

		const result = await streamDevin(model(), context, {
			apiKey: "token",
			headers: { te: "invalid-caller-value" },
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual({ type: "text", text: "split frame" });
	});

	it("fails a clean HTTP/2 close with a truncated Connect header", async () => {
		respond = stream => {
			stream.respond({ ":status": 200 });
			stream.end(new Uint8Array([0, 0, 0]));
		};

		const result = await streamDevin(model(), context, { apiKey: "token" }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("incomplete frame header (3 of 5 bytes)");
		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(false);
	});

	it("rejects an oversized Connect frame at the shared cap", async () => {
		respond = stream => {
			stream.respond({ ":status": 200 });
			const header = new Uint8Array(5);
			new DataView(header.buffer).setUint32(1, 32 * 1024 * 1024, false);
			stream.end(header);
		};

		const result = await streamDevin(model(), context, { apiKey: "token" }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Connect frame payload 33554432 exceeds 16777216 bytes");
	});

	it("surfaces a Connect trailer error", async () => {
		respond = stream => {
			stream.respond({ ":status": 200 });
			stream.end(
				encodeConnectFrame(
					new TextEncoder().encode(
						JSON.stringify({
							error: { code: "permission_denied", message: "Reached overall message rate limit" },
						}),
					),
					CONNECT_END_STREAM_FLAG,
				),
			);
		};

		const result = await streamDevin(model(), context, { apiKey: "token" }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Devin stream error permission_denied: Reached overall message rate limit");
	});

	it("classifies a non-2xx HTTP/2 status as a transient provider error", async () => {
		respond = stream => {
			stream.respond({ ":status": 503, "content-type": "text/plain" });
			stream.end("busy");
		};

		const result = await streamDevin(model(), context, { apiKey: "token" }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(503);
		expect(result.errorMessage).toContain("Devin API error 503: busy");
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
	});

	it("maps HTTP/2 permission failures to a status-bearing credential error", async () => {
		respond = stream => {
			stream.respond({ ":status": 403, "content-type": "text/plain" });
			stream.end("permission denied");
		};

		const result = await streamDevin(model(), context, { apiKey: "token" }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(403);
		expect(result.errorMessage).toContain("Devin API error 403: permission denied");
		expect(AIError.is(result.errorId, AIError.Flag.AuthFailed)).toBe(true);
		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(false);
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(false);
	});
});
