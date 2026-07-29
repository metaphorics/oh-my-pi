import { describe, expect, it } from "bun:test";
import { buildOpenAICompat, buildOpenAIResponsesCompat } from "@oh-my-pi/pi-catalog/compat/openai";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

/**
 * The prompt-cache session header (`promptCacheSessionHeader`) tells the
 * transport which request header carries the normalized prompt-cache key so
 * the provider backend can route to a warm prefix-cache replica. Grok uses
 * `x-grok-conv-id`; Mistral uses `x-affinity`. Every other provider leaves
 * the header unset.
 */
function completionsSpec(provider: string, baseUrl: string): ModelSpec<"openai-completions"> {
	return {
		api: "openai-completions",
		id: "test-model",
		name: "Test Model",
		provider,
		baseUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_000,
		contextWindow: 128_000,
		reasoning: false,
	};
}

describe("buildOpenAICompat promptCacheSessionHeader", () => {
	it("resolves x-affinity for mistral-provider models", () => {
		const compat = buildOpenAICompat(completionsSpec("mistral", "https://api.mistral.ai/v1"));
		expect(compat.promptCacheSessionHeader).toBe("x-affinity");
	});

	it("resolves x-grok-conv-id for grok (xai) models", () => {
		const compat = buildOpenAICompat(completionsSpec("xai", "https://api.x.ai/v1"));
		expect(compat.promptCacheSessionHeader).toBe("x-grok-conv-id");
	});

	it("resolves undefined for unrelated providers", () => {
		const compat = buildOpenAICompat(completionsSpec("openai", "https://api.openai.com/v1"));
		expect(compat.promptCacheSessionHeader).toBeUndefined();
	});
});

describe("buildOpenAIResponsesCompat promptCacheSessionHeader", () => {
	const responsesSpec = (provider: string) => ({
		id: "test-model",
		name: "Test Model",
		provider,
		baseUrl: "",
	});

	it("resolves x-affinity for mistral-provider models", () => {
		expect(buildOpenAIResponsesCompat(responsesSpec("mistral")).promptCacheSessionHeader).toBe("x-affinity");
	});

	it("resolves x-grok-conv-id for xai-oauth models", () => {
		expect(buildOpenAIResponsesCompat(responsesSpec("xai-oauth")).promptCacheSessionHeader).toBe("x-grok-conv-id");
	});

	it("resolves undefined for unrelated providers", () => {
		expect(buildOpenAIResponsesCompat(responsesSpec("openai")).promptCacheSessionHeader).toBeUndefined();
	});
});
