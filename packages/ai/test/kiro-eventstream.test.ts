import { describe, expect, test } from "bun:test";
import { decodeEventStream, decodeMessage } from "@oh-my-pi/pi-ai/providers/aws-eventstream";

const fixturePath = `${import.meta.dir}/fixtures/kiro-eventstream.bin`;
const fixtureBytes = new Uint8Array(await Bun.file(fixturePath).arrayBuffer());

function chunkedStream(bytes: Uint8Array, boundaries: readonly number[]): ReadableStream<Uint8Array> {
	let offset = 0;
	let boundaryIndex = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			const next = Math.min(bytes.length, offset + (boundaries[boundaryIndex] ?? bytes.length));
			controller.enqueue(bytes.slice(offset, next));
			offset = next;
			boundaryIndex += 1;
		},
	});
}

describe("Kiro AWS EventStream capture", () => {
	test("validates captured CRCs and typed headers", async () => {
		const bytes = fixtureBytes;
		const firstLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
		const first = decodeMessage(bytes.subarray(0, firstLength));

		expect(first.headers).toEqual({
			":event-type": "initial-response",
			":content-type": "application/x-amz-json-1.0",
			":message-type": "event",
		});
		expect(new TextDecoder().decode(first.payload)).toBe('{"conversationId":""}');
	});

	test("stitches captured messages split across arbitrary chunks", async () => {
		const bytes = fixtureBytes;
		const events: Array<{ type: string | undefined; payload: string }> = [];
		for await (const message of decodeEventStream(chunkedStream(bytes, [1, 2, 7, 13, 31, 5, 89]))) {
			events.push({
				type: message.headers[":event-type"],
				payload: new TextDecoder().decode(message.payload),
			});
		}

		expect(events.map(event => event.type)).toEqual([
			"initial-response",
			"assistantResponseEvent",
			"assistantResponseEvent",
			"metadataEvent",
			"contextUsageEvent",
			"meteringEvent",
		]);
		expect(events.filter(event => event.type === "assistantResponseEvent").map(event => event.payload)).toEqual([
			'{"content":"Hi"}',
			'{"content":"!"}',
		]);
	});

	test("rejects a truncated captured message", async () => {
		const bytes = fixtureBytes;
		const truncated = bytes.subarray(0, bytes.length - 1);
		const consume = async () => {
			for await (const _message of decodeEventStream(chunkedStream(truncated, [truncated.length]))) {
				// Drain the decoder so it can verify the terminal frame.
			}
		};

		await expect(consume()).rejects.toThrow("truncated message at end of stream");
	});
});
