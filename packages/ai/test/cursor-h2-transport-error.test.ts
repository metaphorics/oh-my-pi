import { describe, expect, it } from "bun:test";
import { isTransientTransportError } from "@oh-my-pi/pi-ai";

describe("Cursor shared HTTP/2 transport classification", () => {
	it("recognizes an ALPN negotiation failure as transient", () => {
		const error = Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" });
		expect(isTransientTransportError(error)).toBeTrue();
	});

	it("recognizes HTTP/2 stream resets and common socket failures", () => {
		expect(isTransientTransportError(new Error("Stream closed with error code NGHTTP2_INTERNAL_ERROR"))).toBeTrue();
		expect(isTransientTransportError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBeTrue();
	});

	it("does not replay arbitrary HTTP/2 or authentication failures", () => {
		expect(isTransientTransportError(new Error("HTTP/2 protocol invariant failed"))).toBeFalse();
		expect(isTransientTransportError(Object.assign(new Error("Forbidden"), { status: 403 }))).toBeFalse();
	});
});
