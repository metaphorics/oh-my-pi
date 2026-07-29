import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Context, Model, UserMessage } from "@oh-my-pi/pi-ai/types";
import { clampMaxTokensToContext, estimatePromptTokens } from "@oh-my-pi/pi-ai/utils/output-budget";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// ─── clampMaxTokensToContext ─────────────────────────────────────────────────

describe("clampMaxTokensToContext", () => {
	it("passes through when contextWindow is undefined", () => {
		expect(
			clampMaxTokensToContext({
				requestedMaxTokens: 16384,
				contextWindow: undefined,
				estimatedPromptTokens: 100000,
			}),
		).toBe(16384);
	});

	it("passes through when contextWindow is zero", () => {
		expect(
			clampMaxTokensToContext({
				requestedMaxTokens: 8192,
				contextWindow: 0,
				estimatedPromptTokens: 100,
			}),
		).toBe(8192);
	});

	it("passes through when contextWindow is negative", () => {
		expect(
			clampMaxTokensToContext({
				requestedMaxTokens: 8192,
				contextWindow: -1,
				estimatedPromptTokens: 100,
			}),
		).toBe(8192);
	});

	it("is a no-op when the request already fits", () => {
		// window=200000, prompt=10000, reserve=4096 → budget=185904; requested 8192 fits
		expect(
			clampMaxTokensToContext({
				requestedMaxTokens: 8192,
				contextWindow: 200_000,
				estimatedPromptTokens: 10_000,
			}),
		).toBe(8192);
	});

	it("reduces when prompt + requested exceeds the window", () => {
		// window=200000, prompt=195000, reserve=4096 → budget=max(1, 904)=904
		expect(
			clampMaxTokensToContext({
				requestedMaxTokens: 16384,
				contextWindow: 200_000,
				estimatedPromptTokens: 195_000,
			}),
		).toBe(904);
	});

	it("floors at 1 when the budget would be non-positive", () => {
		// window=100, prompt=200, reserve=4096 → budget=max(1, -4196)=1
		expect(
			clampMaxTokensToContext({
				requestedMaxTokens: 8192,
				contextWindow: 100,
				estimatedPromptTokens: 200,
			}),
		).toBe(1);
	});

	it("respects a custom reserveTokens", () => {
		// window=200000, prompt=190000, reserve=8000 → budget=max(1, 2000)=2000
		expect(
			clampMaxTokensToContext({
				requestedMaxTokens: 16384,
				contextWindow: 200_000,
				estimatedPromptTokens: 190_000,
				reserveTokens: 8000,
			}),
		).toBe(2000);
	});
});

// ─── estimatePromptTokens ────────────────────────────────────────────────────

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: { ...EMPTY_USAGE },
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("estimatePromptTokens", () => {
	it("returns 0 for empty inputs", () => {
		expect(estimatePromptTokens(undefined, [])).toBe(0);
	});

	it("counts system prompt text", () => {
		const text = "Hello world"; // 11 bytes → (11+3)>>2 = 3
		expect(estimatePromptTokens(text, [])).toBe((Buffer.byteLength(text, "utf-8") + 3) >> 2);
	});

	it("counts string message content", () => {
		const msg: UserMessage = { role: "user", content: "test message", timestamp: 0 };
		const expected = (Buffer.byteLength("test message", "utf-8") + 3) >> 2;
		expect(estimatePromptTokens(undefined, [msg])).toBe(expected);
	});

	it("counts text blocks in array content", () => {
		const msg: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: 0,
		};
		const expected = (Buffer.byteLength("hello", "utf-8") + 3) >> 2;
		expect(estimatePromptTokens(undefined, [msg])).toBe(expected);
	});

	it("adds IMAGE_TOKEN_ESTIMATE per image block", () => {
		const msg: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "describe" },
				{ type: "image", data: "abc", mimeType: "image/png" },
				{ type: "image", data: "def", mimeType: "image/jpeg" },
			],
			timestamp: 0,
		};
		const textTokens = (Buffer.byteLength("describe", "utf-8") + 3) >> 2;
		expect(estimatePromptTokens(undefined, [msg])).toBe(textTokens + 1200 + 1200);
	});

	it("counts thinking blocks in array content", () => {
		const thinking = "Let me reason about this step by step.";
		const msg = assistantMessage([{ type: "thinking", thinking }]);
		const expected = (Buffer.byteLength(thinking, "utf-8") + 3) >> 2;
		expect(estimatePromptTokens(undefined, [msg])).toBe(expected);
	});

	it("counts toolCall blocks in array content", () => {
		const arguments_ = { command: "ls -la /workspace", cwd: "/home" };
		const msg = assistantMessage([{ type: "toolCall", id: "call-1", name: "bash", arguments: arguments_ }]);
		const expected = (Buffer.byteLength(JSON.stringify({ name: "bash", arguments: arguments_ }), "utf-8") + 3) >> 2;
		expect(estimatePromptTokens(undefined, [msg])).toBe(expected);
	});

	it("counts serialized tools", () => {
		const tools = [{ name: "read", description: "Read a file" }];
		const toolJson = JSON.stringify(tools);
		const expected = (Buffer.byteLength(toolJson, "utf-8") + 3) >> 2;
		expect(estimatePromptTokens(undefined, [], tools)).toBe(expected);
	});

	it("combines system prompt, messages, and tools", () => {
		const system = "Be concise.";
		const msg: UserMessage = { role: "user", content: "hi", timestamp: 0 };
		const tools = [{ name: "bash" }];
		const expected =
			((Buffer.byteLength(system, "utf-8") + 3) >> 2) +
			((Buffer.byteLength("hi", "utf-8") + 3) >> 2) +
			((Buffer.byteLength(JSON.stringify(tools), "utf-8") + 3) >> 2);
		expect(estimatePromptTokens(system, [msg], tools)).toBe(expected);
	});
});

// ─── Anthropic request-building integration ──────────────────────────────────

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function makeModel(contextWindow: number, maxTokens: number): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	});
}

/** Reasoning-capable variant so extended-thinking params are built on the wire. */
function makeThinkingModel(contextWindow: number, maxTokens: number): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	});
}

function capturePayload(
	model: Model<"anthropic-messages">,
	context: Context,
	maxTokens?: number,
	thinking?: { enabled: boolean; budgetTokens?: number },
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamAnthropic(model, context, {
		apiKey: "sk-ant-test",
		signal: createAbortedSignal(),
		maxTokens,
		...(thinking && { thinkingEnabled: thinking.enabled, thinkingBudgetTokens: thinking.budgetTokens }),
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

describe("anthropic output-budget clamp integration", () => {
	it("shrinks an oversized declared max_tokens to fit the context window", async () => {
		// contextWindow=10000, maxTokens(model)=8192, requested=8192
		// A large prompt (~6000 tokens estimated) leaves little room.
		const model = makeModel(10_000, 8_192);
		// Build a prompt that estimates to ~6000 tokens: 24000 bytes → (24000+3)>>2 = 6000
		const bigText = "x".repeat(24_000);
		const context: Context = {
			messages: [{ role: "user", content: bigText, timestamp: Date.now() }],
		};
		const payload = await capturePayload(model, context, 8192);
		// budget = max(1, 10000 - 6000 - 4096) = max(1, -96) = 1
		// clamp: min(8192, 1) = 1
		expect(payload.max_tokens).toBe(1);
	});

	it("leaves a fitting max_tokens untouched", async () => {
		const model = makeModel(200_000, 8_192);
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};
		const payload = await capturePayload(model, context, 4096);
		// prompt estimate is tiny; budget >> 4096, so no clamp
		expect(payload.max_tokens).toBe(4096);
	});

	it("keeps max_tokens above thinking.budget_tokens after clamping a near-full window", async () => {
		// contextWindow=16000, prompt≈6000 tokens, requested=8192, thinkingBudget=4000.
		// clamp budget = max(1, 16000 - 6000 - 4096) = 5904 → max_tokens = min(8192, 5904) = 5904.
		// reconcile: 4000 + OUTPUT_FALLBACK_BUFFER(4000) = 8000 > 5904 → budget = 5904 - 4000 = 1904.
		const model = makeThinkingModel(16_000, 8_192);
		const bigText = "x".repeat(24_000);
		const context: Context = {
			messages: [{ role: "user", content: bigText, timestamp: Date.now() }],
		};
		const payload = await capturePayload(model, context, 8192, { enabled: true, budgetTokens: 4000 });
		expect(payload.max_tokens).toBe(5904);
		expect(payload.thinking).toMatchObject({ type: "enabled", budget_tokens: 1904 });
		const thinking = payload.thinking as { budget_tokens: number } | undefined;
		expect((payload.max_tokens as number) > (thinking?.budget_tokens ?? 0)).toBe(true);
	});

	it("disables thinking when the window is too tight for a viable budget", async () => {
		// contextWindow=10000, prompt≈6000 tokens, requested=8192, thinkingBudget=4000.
		// clamp budget = max(1, 10000 - 6000 - 4096) = 1 → max_tokens = 1.
		// reconcile: clampedBudget = 1 - 4000 < 1024 (MIN) → thinking disabled.
		const model = makeThinkingModel(10_000, 8_192);
		const bigText = "x".repeat(24_000);
		const context: Context = {
			messages: [{ role: "user", content: bigText, timestamp: Date.now() }],
		};
		const payload = await capturePayload(model, context, 8192, { enabled: true, budgetTokens: 4000 });
		expect(payload.max_tokens).toBe(1);
		expect(payload.thinking).toBeUndefined();
	});
});

// ─── Bedrock request-building integration ────────────────────────────────────

function makeBedrockModel(contextWindow: number, maxTokens: number): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "anthropic.claude-sonnet-4-5",
		name: "Claude Sonnet 4.5 (Bedrock)",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	});
}

function captureBedrockPayload(
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: { maxTokens?: number; reasoning?: "medium"; interleavedThinking?: boolean },
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	// The stream is only observed for its onPayload snapshot and then abandoned.
	// A bearer token keeps the abandoned continuation off the AWS-credentials
	// path (see bedrock-prompt-cache.test.ts for the unhandled-rejection trap).
	void streamBedrock(model, context, {
		apiKey: "test-key",
		signal: createAbortedSignal(),
		...options,
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

describe("bedrock output-budget clamp integration", () => {
	it("reconciles the thinking budget under the clamped maxTokens", async () => {
		// contextWindow=16000, prompt≈6000 tokens, requested=8192, effort medium (budget 8192).
		// clamp: min(8192, max(1, 16000 - 6000 - 4096)) = 5904.
		// reconcile: 8192 + 4000 > 5904 → budget = 5904 - 4000 = 1904 (≥ 1024 floor).
		const model = makeBedrockModel(16_000, 8_192);
		const bigText = "x".repeat(24_000);
		const context: Context = {
			messages: [{ role: "user", content: bigText, timestamp: Date.now() }],
		};
		const payload = await captureBedrockPayload(model, context, { maxTokens: 8192, reasoning: "medium" });
		expect(payload.inferenceConfig).toMatchObject({ maxTokens: 5904 });
		expect(payload.additionalModelRequestFields).toMatchObject({
			thinking: { type: "enabled", budget_tokens: 1904 },
		});
	});

	it("drops thinking and the interleaved beta when the window is too tight", async () => {
		// contextWindow=10000, prompt≈6000 tokens → clamp to 1.
		// reconcile: 1 - 4000 < 1024 → thinking dropped; the interleaved beta must
		// not survive without it, leaving no additional fields at all.
		const model = makeBedrockModel(10_000, 8_192);
		const bigText = "x".repeat(24_000);
		const context: Context = {
			messages: [{ role: "user", content: bigText, timestamp: Date.now() }],
		};
		const payload = await captureBedrockPayload(model, context, {
			maxTokens: 8192,
			reasoning: "medium",
			interleavedThinking: true,
		});
		expect(payload.inferenceConfig).toMatchObject({ maxTokens: 1 });
		expect(payload.additionalModelRequestFields).toBeUndefined();
	});
});
