import { describe, expect, it } from "bun:test";
import { formatMCPConnectingMessage, MCP_CONNECTING_EVENT_CHANNEL } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";

// Cross-module contract guard.
//
// The MCP "connecting" banner spans two modules that never import each other:
//   - sdk.ts (onMCPConnecting) EMITS on MCP_CONNECTING_EVENT_CHANNEL.
//   - interactive-mode.ts SUBSCRIBES to that same channel and renders the
//     banner via showStatus(formatMCPConnectingMessage(serverNames)).
//
// They agree only by sharing this module's two exports. Two drifts silently
// kill the banner with no type error and no crash:
//   1. the channel string diverging between emitter and subscriber, and
//   2. the user-facing banner text (esp. the exact trailing ellipsis char).
// These assertions pin both halves of that contract.
describe("mcp/startup-events — connecting-banner cross-module contract", () => {
	it("pins the wire channel string sdk(emit) and interactive-mode(subscribe) share", () => {
		// A drift here desyncs publisher and subscriber: the event fires on one
		// string, nobody listens on the other, and the banner vanishes silently.
		expect(MCP_CONNECTING_EVENT_CHANNEL).toBe("mcp:connecting");
	});

	it("formats the exact banner for a multi-server list (comma-joined names)", () => {
		expect(formatMCPConnectingMessage(["alpha", "beta", "gamma"])).toBe(
			"Connecting to MCP servers: alpha, beta, gamma…",
		);
	});

	it("formats the exact banner for a single server (no separators)", () => {
		expect(formatMCPConnectingMessage(["solo"])).toBe("Connecting to MCP servers: solo…");
	});

	it("terminates the banner with a single U+2026 ellipsis, not an ASCII '...'", () => {
		// The source uses one HORIZONTAL ELLIPSIS codepoint. A refactor to "..."
		// would still "look right" in a terminal but break exact-match expectations
		// and any downstream byte-sensitive consumer, so guard the codepoint itself.
		const msg = formatMCPConnectingMessage(["x"]);
		expect(msg.endsWith("\u2026")).toBe(true);
		expect(msg.endsWith("...")).toBe(false);
		expect(msg.at(-1)).toBe("\u2026");
	});
});
