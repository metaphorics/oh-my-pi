import { afterEach, describe, expect, it } from "bun:test";
import http2 from "node:http2";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { crc32 } from "@oh-my-pi/pi-ai/providers/aws-eventstream";
import { streamKiro } from "@oh-my-pi/pi-ai/providers/kiro";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

type Scenario =
	| { kind: "http-error"; status: number; body: string }
	| { kind: "eventstream-exception"; exceptionType: string; body: string }
	| { kind: "truncated-frame" };

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();
let scenario: Scenario = {
	kind: "http-error",
	status: 400,
	body: JSON.stringify({ __type: "ValidationException", message: "fixture reset" }),
};

function encodeStringHeader(name: string, value: string): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const valueBytes = new TextEncoder().encode(value);
	if (nameBytes.length > 255) throw new Error("name too long");
	const buffer = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(buffer.buffer);
	let offset = 0;
	view.setUint8(offset, nameBytes.length);
	offset += 1;
	buffer.set(nameBytes, offset);
	offset += nameBytes.length;
	view.setUint8(offset, 7);
	offset += 1;
	view.setUint16(offset, valueBytes.length, false);
	offset += 2;
	buffer.set(valueBytes, offset);
	return buffer;
}

function encodeFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
	const headerChunks: Uint8Array[] = [];
	for (const name in headers) headerChunks.push(encodeStringHeader(name, headers[name]));
	const headerLength = headerChunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const headerBytes = new Uint8Array(headerLength);
	let offset = 0;
	for (const chunk of headerChunks) {
		headerBytes.set(chunk, offset);
		offset += chunk.length;
	}
	const totalLength = 4 + 4 + 4 + headerLength + payload.length + 4;
	const frame = new Uint8Array(totalLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, totalLength, false);
	view.setUint32(4, headerLength, false);
	view.setUint32(8, crc32(frame.subarray(0, 8)), false);
	frame.set(headerBytes, 12);
	frame.set(payload, 12 + headerLength);
	view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
	return frame;
}

function exceptionFrame(exceptionType: string, body: string): Uint8Array {
	return encodeFrame(
		{
			":message-type": "exception",
			":exception-type": exceptionType,
			":content-type": "application/x-amz-json-1.0",
		},
		new TextEncoder().encode(body),
	);
}

function toolUseFrame(): Uint8Array {
	return encodeFrame(
		{ ":message-type": "event", ":event-type": "toolUseEvent" },
		new TextEncoder().encode({
			toolUseId: "unfinished_tool",
			name: "read_file",
			input: JSON.stringify({ path: "/tmp/input" }),
		}),
	);
}

async function startServer(): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", stream => {
		stream.on("data", () => {});
		if (scenario.kind === "http-error") {
			stream.respond({ ":status": scenario.status, "content-type": "application/x-amz-json-1.0" });
			stream.end(scenario.body);
			return;
		}
		stream.respond({ ":status": 200, "content-type": "application/vnd.amazon.eventstream" });
		if (scenario.kind === "eventstream-exception") {
			stream.end(Buffer.concat([toolUseFrame(), exceptionFrame(scenario.exceptionType, scenario.body)]));
			return;
		}
		const frame = exceptionFrame("validationException", JSON.stringify({ message: "frame cut short" }));
		stream.end(frame.subarray(0, frame.length - 1));
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected HTTP/2 fixture server to bind a TCP port");
	return `http://127.0.0.1:${address.port}`;
}

function makeModel(baseUrl: string): Model<"kiro-agent"> {
	return buildModel({
		id: "kiro-compaction-fixture",
		name: "Kiro compaction fixture",
		api: "kiro-agent",
		provider: "kiro",
		baseUrl,
		reasoning: false,
		input: ["text"],
		supportsTools: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 1_024,
	});
}

const context: Context = {
	messages: [{ role: "user", content: "make this request too large", timestamp: 1 }],
};

async function collectStream(
	model: Model<"kiro-agent">,
	signal?: AbortSignal,
): Promise<{ eventTypes: string[]; result: AssistantMessage }> {
	const stream = streamKiro(model, context, { apiKey: "test-token", signal });
	const eventTypes: string[] = [];
	for await (const event of stream) eventTypes.push(event.type);
	return { eventTypes, result: await stream.result() };
}

async function stopServer(): Promise<void> {
	for (const session of sessions) session.destroy();
	sessions.clear();
	const current = server;
	server = undefined;
	if (!current) return;
	const closed = Promise.withResolvers<void>();
	current.close(error => (error ? closed.reject(error) : closed.resolve()));
	await closed.promise;
}

function expectTerminalError(eventTypes: string[], result: AssistantMessage): void {
	expect(result.stopReason).toBe("error");
	expect(result.stopReason).not.toBe("toolUse");
	expect(eventTypes).toContain("error");
	expect(eventTypes).not.toContain("done");
}

afterEach(async () => {
	await stopServer();
});

describe("Kiro oversized-request classification", () => {
	it("classifies a non-2xx AWS JSON validation body as context overflow without completing", async () => {
		const overflow = "Input is too long for requested model. Maximum input length is 8,192 tokens.";
		scenario = {
			kind: "http-error",
			status: 400,
			body: JSON.stringify({ __type: "ValidationException", message: overflow }),
		};
		const { eventTypes, result } = await collectStream(makeModel(await startServer()));

		expectTerminalError(eventTypes, result);
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain(overflow);
		expect(result.errorId).toBe(AIError.create(AIError.Flag.ContextOverflow));
		expect(AIError.isContextOverflow(result)).toBe(true);
	});

	it("classifies an AWS EventStream validation exception as context overflow without completing", async () => {
		const overflow = "Input is too long for requested model. Maximum input length is 8,192 tokens.";
		scenario = {
			kind: "eventstream-exception",
			exceptionType: "validationException",
			body: JSON.stringify({ message: overflow }),
		};
		const { eventTypes, result } = await collectStream(makeModel(await startServer()));

		expectTerminalError(eventTypes, result);
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain(overflow);
		expect(result.errorId).toBe(AIError.create(AIError.Flag.ContextOverflow));
		expect(AIError.isContextOverflow(result)).toBe(true);
		expect(eventTypes).not.toContain("toolcall_end");
	});

	it("does not misclassify an adjacent AWS validation error as context overflow", async () => {
		const detail = "modelId is required";
		scenario = {
			kind: "http-error",
			status: 400,
			body: JSON.stringify({ __type: "ValidationException", message: detail }),
		};
		const { eventTypes, result } = await collectStream(makeModel(await startServer()));

		expectTerminalError(eventTypes, result);
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain(detail);
		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(false);
		expect(AIError.isContextOverflow(result)).toBe(false);
	});

	it("keeps an opaque EventStream service exception transient rather than treating it as overflow", async () => {
		const detail = "execution engine unavailable";
		scenario = {
			kind: "eventstream-exception",
			exceptionType: "internalServerException",
			body: JSON.stringify({ message: detail }),
		};
		const { eventTypes, result } = await collectStream(makeModel(await startServer()));

		expectTerminalError(eventTypes, result);
		expect(result.errorStatus).toBe(503);
		expect(result.errorMessage).toContain(detail);
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(false);
		expect(AIError.isContextOverflow(result)).toBe(false);
	});

	it("surfaces a truncated EventStream frame as an error without completing", async () => {
		scenario = { kind: "truncated-frame" };
		const { eventTypes, result } = await collectStream(makeModel(await startServer()));

		expectTerminalError(eventTypes, result);
		expect(result.errorMessage).toContain("truncated message at end of stream");
		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(false);
	});

	it("keeps a caller-cancelled stream aborted rather than classifying it as overflow", async () => {
		const controller = new AbortController();
		controller.abort();
		const { eventTypes, result } = await collectStream(makeModel("http://127.0.0.1:1"), controller.signal);

		expect(result.stopReason).toBe("aborted");
		expect(eventTypes).toEqual(["error"]);
		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(false);
		expect(AIError.isContextOverflow(result)).toBe(false);
	});
});
