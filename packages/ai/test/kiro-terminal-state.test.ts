import { afterEach, describe, expect, it } from "bun:test";
import http2 from "node:http2";
import { crc32 } from "@oh-my-pi/pi-ai/providers/aws-eventstream";
import { streamKiro } from "@oh-my-pi/pi-ai/providers/kiro";
import type { AssistantMessage, Context, Model, ToolCall } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Regression coverage for the Kiro terminal-state invariant: a completion is
 * only accepted once the EventStream carries a `metadataEvent` whose
 * `stopReason` is `END_TURN`. Before the fix, the presence of any
 * `toolUseEvent` forced the derived `stopReason` to `toolUse` even when the
 * stream closed before that metadata — letting truncated tool arguments
 * through as a completed tool call.
 */

type Scenario = { kind: "complete-tool-use" } | { kind: "truncated-tool-use" };

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();
let scenario: Scenario = { kind: "complete-tool-use" };

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

function encodeKiroEvent(eventType: string, payload: object): Uint8Array {
	return encodeFrame(
		{ ":message-type": "event", ":event-type": eventType },
		new TextEncoder().encode(JSON.stringify(payload)),
	);
}

/** A toolUseEvent opening a call with a fully-formed `input` JSON string. */
function toolUseStartFrame(): Uint8Array {
	return encodeKiroEvent("toolUseEvent", {
		toolUseId: "tool_1",
		name: "read_file",
		// Kiro streams tool arguments as a JSON-text delta in `input`.
		input: JSON.stringify({ path: "/etc/passwd" }),
	});
}

function endTurnMetadataFrame(): Uint8Array {
	return encodeKiroEvent("metadataEvent", { stopReason: "END_TURN" });
}

async function startServer(): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		stream.on("data", () => {});
		stream.respond({ ":status": 200, "content-type": "application/vnd.amazon.eventstream" });
		if (scenario.kind === "complete-tool-use") {
			stream.write(Buffer.concat([toolUseStartFrame(), endTurnMetadataFrame()]));
			stream.end();
			return;
		}
		// truncated-tool-use: a toolUseEvent, then the stream closes with no
		// metadataEvent — the defect window.
		stream.write(toolUseStartFrame());
		stream.end();
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected http2 fixture server to bind a tcp port");
	}
	return `http://127.0.0.1:${address.port}`;
}

function makeModel(baseUrl: string): Model<"kiro-agent"> {
	return buildModel({
		id: "kiro-terminal-fixture",
		name: "Kiro terminal fixture",
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
	messages: [{ role: "user", content: "call the tool", timestamp: 1 }],
};

async function collectStream(model: Model<"kiro-agent">): Promise<{
	eventTypes: string[];
	result: AssistantMessage;
}> {
	const stream = streamKiro(model, context, { apiKey: "test-token" });
	const eventTypes: string[] = [];
	for await (const event of stream) {
		eventTypes.push(event.type);
	}
	const result = await stream.result();
	return { eventTypes, result };
}

async function stopServer(): Promise<void> {
	for (const session of sessions) {
		session.destroy();
	}
	sessions.clear();
	const current = server;
	server = undefined;
	if (!current) return;
	const closed = Promise.withResolvers<void>();
	current.close(error => (error ? closed.reject(error) : closed.resolve()));
	await closed.promise;
}

afterEach(async () => {
	scenario = { kind: "complete-tool-use" };
	await stopServer();
});

describe("Kiro terminal-state invariant", () => {
	it("accepts a complete tool use only after END_TURN metadata", async () => {
		scenario = { kind: "complete-tool-use" };
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));

		expect(result.stopReason).toBe("toolUse");
		const toolCall = result.content.find((block): block is ToolCall => block.type === "toolCall");
		expect(toolCall).toBeDefined();
		if (toolCall) {
			expect(toolCall.name).toBe("read_file");
			expect(toolCall.arguments).toMatchObject({ path: "/etc/passwd" });
		}
		expect(eventTypes).toContain("done");
		expect(eventTypes[eventTypes.length - 1]).toBe("done");
	});

	it("rejects a truncated tool use that closes without END_TURN metadata", async () => {
		scenario = { kind: "truncated-tool-use" };
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));

		// The defect surfaced the partial toolUseEvent as a completed call. The
		// invariant now requires END_TURN first, so the response must error and
		// never report a toolUse stop reason.
		expect(result.stopReason).toBe("error");
		expect(result.stopReason).not.toBe("toolUse");
		expect(result.errorMessage).toContain("without END_TURN");
		expect(eventTypes[eventTypes.length - 1]).toBe("error");
		expect(eventTypes).not.toContain("done");
	});
});
