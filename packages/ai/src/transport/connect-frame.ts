import { gunzipSync } from "node:zlib";

export const CONNECT_COMPRESSED_FLAG = 0x01;
export const CONNECT_END_STREAM_FLAG = 0x02;
const CONNECT_HEADER_BYTES = 5;
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export function encodeConnectFrame(payload: Uint8Array, flags = 0): Uint8Array {
	const frame = new Uint8Array(CONNECT_HEADER_BYTES + payload.byteLength);
	frame[0] = flags;
	new DataView(frame.buffer, frame.byteOffset, CONNECT_HEADER_BYTES).setUint32(1, payload.byteLength, false);
	frame.set(payload, CONNECT_HEADER_BYTES);
	return frame;
}

export interface ConnectFrame {
	flags: number;
	payload: Uint8Array;
	endOfStream: boolean;
}

export function createConnectFrameReader(options?: { maxPayloadBytes?: number }): {
	push(chunk: Uint8Array): ConnectFrame[];
} {
	const maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
	if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 0) {
		throw new RangeError("maxPayloadBytes must be a non-negative safe integer");
	}
	let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

	return {
		push(chunk: Uint8Array): ConnectFrame[] {
			if (chunk.byteLength > 0) {
				if (pending.byteLength === 0) {
					pending = chunk;
				} else {
					const joined = new Uint8Array(pending.byteLength + chunk.byteLength);
					joined.set(pending);
					joined.set(chunk, pending.byteLength);
					pending = joined;
				}
			}

			const frames: ConnectFrame[] = [];
			let offset = 0;
			while (pending.byteLength - offset >= CONNECT_HEADER_BYTES) {
				const view = new DataView(pending.buffer, pending.byteOffset + offset, CONNECT_HEADER_BYTES);
				const flags = view.getUint8(0);
				const payloadLength = view.getUint32(1, false);
				if (payloadLength > maxPayloadBytes) {
					throw new RangeError(`Connect frame payload ${payloadLength} exceeds ${maxPayloadBytes} bytes`);
				}
				if (pending.byteLength - offset < CONNECT_HEADER_BYTES + payloadLength) break;

				const encoded = pending.subarray(
					offset + CONNECT_HEADER_BYTES,
					offset + CONNECT_HEADER_BYTES + payloadLength,
				);
				const payload =
					(flags & CONNECT_COMPRESSED_FLAG) !== 0
						? new Uint8Array(gunzipSync(encoded, { maxOutputLength: maxPayloadBytes }))
						: encoded;
				frames.push({ flags, payload, endOfStream: (flags & CONNECT_END_STREAM_FLAG) !== 0 });
				offset += CONNECT_HEADER_BYTES + payloadLength;
			}

			if (offset === pending.byteLength) pending = new Uint8Array(0);
			else if (offset > 0) pending = pending.subarray(offset);
			return frames;
		},
	};
}

export function readConnectTrailerError(payload: Uint8Array): { code: string; message: string } | null {
	if (payload.byteLength === 0) return null;
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(payload));
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || !("error" in value)) return null;
	const error = value.error;
	if (!error || typeof error !== "object") return null;
	const code = "code" in error && typeof error.code === "string" ? error.code : "";
	const message = "message" in error && typeof error.message === "string" ? error.message : "";
	return code || message ? { code, message } : null;
}
