import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	estimateTokens,
	estimateTokensUncached,
	invalidateTokenEstimate,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { applyShakeRegion } from "@oh-my-pi/pi-agent-core/compaction";
import type { SessionMessageEntry } from "@oh-my-pi/pi-agent-core/compaction";

function assistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason" | "usage">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		...overrides,
	};
}

function unsettledAssistant(content: AssistantMessage["content"]): AssistantMessage {
	// Streaming partials clear stopReason while mutating content under the same identity.
	const message = assistantMessage(content);
	(message as { stopReason?: AssistantMessage["stopReason"] }).stopReason = undefined;
	return message;
}

function toolResult(text: string, images = 0): ToolResultMessage {
	const content: ToolResultMessage["content"] = [{ type: "text", text }];
	for (let i = 0; i < images; i++) {
		content.push({ type: "image", data: `img${i}`, mimeType: "image/png" });
	}
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content,
		isError: false,
		timestamp: Date.now(),
	};
}

describe("estimateTokens memo", () => {
	test("memoized values match uncached for representative roles and options", () => {
		const samples: AgentMessage[] = [
			{ role: "user", content: "hello world ".repeat(20), timestamp: 1 },
			toolResult("tool payload ".repeat(40)),
			assistantMessage([
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "reason", thinkingSignature: "sig-blob-".repeat(10) },
			]),
		];
		for (const message of samples) {
			expect(estimateTokens(message)).toBe(estimateTokensUncached(message));
			expect(estimateTokens(message, { excludeEncryptedReasoning: true })).toBe(
				estimateTokensUncached(message, { excludeEncryptedReasoning: true }),
			);
		}
	});

	test("excludeEncryptedReasoning is option-separated from the default cache", () => {
		const message = assistantMessage([
			{ type: "thinking", thinking: "visible", thinkingSignature: "encrypted-payload-".repeat(30) },
		]);
		const withEncrypted = estimateTokens(message);
		const withoutEncrypted = estimateTokens(message, { excludeEncryptedReasoning: true });
		expect(withEncrypted).toBeGreaterThan(withoutEncrypted);
		// Settled assistants are identity-memoized per option map; values stay option-correct.
		expect(estimateTokens(message)).toBe(withEncrypted);
		expect(estimateTokens(message, { excludeEncryptedReasoning: true })).toBe(withoutEncrypted);
	});

	test("in-place streaming assistant mutations re-estimate without stale hits", () => {
		const message = unsettledAssistant([{ type: "text", text: "partial" }]);
		const first = estimateTokens(message);
		message.content.push({ type: "text", text: " more text ".repeat(50) });
		const second = estimateTokens(message);
		expect(second).toBeGreaterThan(first);
		expect(second).toBe(estimateTokensUncached(message));
	});

	test("same-object unsettled assistant toolCall.arguments growth re-estimates", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "c1",
			name: "bash",
			arguments: { command: "echo start" },
		};
		const message = unsettledAssistant([toolCall]);
		const first = estimateTokens(message);
		toolCall.arguments = { command: "echo start && " + "x".repeat(400) };
		const second = estimateTokens(message);
		expect(second).toBeGreaterThan(first);
		expect(second).toBe(estimateTokensUncached(message));
	});

	test("same-length unsettled assistant text rewrite re-estimates", () => {
		const textBlock = { type: "text" as const, text: "abcdefghij" }; // 10 ASCII bytes
		const message = unsettledAssistant([textBlock]);
		const first = estimateTokens(message);
		// Same char length, higher UTF-8 byte length — length-only fingerprints miss this.
		textBlock.text = "áááááááááá";
		const second = estimateTokens(message);
		expect(second).toBeGreaterThan(first);
		expect(second).toBe(estimateTokensUncached(message));
	});
	test("settled assistants are identity-memoized once terminal", () => {
		const message = assistantMessage([{ type: "text", text: "final answer ".repeat(40) }]);
		const first = estimateTokens(message);
		expect(estimateTokens(message)).toBe(first);
		expect(first).toBe(estimateTokensUncached(message));
	});

	test("pruned tool result re-estimates after owner invalidation", () => {
		const message = toolResult("huge tool result body ".repeat(80));
		const before = estimateTokens(message);
		expect(before).toBe(estimateTokens(message)); // warm default cache
		message.content = [{ type: "text", text: "[Old tool result content cleared]" }];
		// Without invalidation this would be stale; the owner seam must clear both maps.
		invalidateTokenEstimate(message);
		const after = estimateTokens(message);
		expect(after).toBeLessThan(before);
		expect(after).toBe(estimateTokensUncached(message));
	});

	test("shake toolResult rewrite invalidates token estimates", () => {
		const message = toolResult("shakeable tool body ".repeat(100));
		const before = estimateTokens(message);
		const entry: SessionMessageEntry = {
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message,
		};
		applyShakeRegion(
			{
				kind: "toolResult",
				entry,
				tokens: before,
				originalText: "shakeable tool body ".repeat(100),
				label: "bash",
			},
			"[shaken]",
		);
		const after = estimateTokens(message);
		expect(after).toBeLessThan(before);
		expect(after).toBe(estimateTokensUncached(message));
	});
});
