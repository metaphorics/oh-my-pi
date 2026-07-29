/**
 * Request-side output-token budget clamp.
 *
 * On APIs where max output tokens is mandatory on the wire (anthropic, bedrock),
 * a prompt that fits the context window on its own can still be rejected once
 * the declared output allowance pushes prompt + output past the window. This
 * module provides a conservative clamp that only ever reduces the requested
 * max, never raises it, and passes through when the window is unknown.
 */

import type { Message } from "../types";

/**
 * Image content has no tokenizer representation; charge a fixed estimate
 * matching what providers typically bill for inline images.
 */
const IMAGE_TOKEN_ESTIMATE = 1200;

/** Default safety reserve subtracted from the remaining window. */
const DEFAULT_RESERVE_TOKENS = 4096;

/**
 * Clamp a requested max-output value so that prompt + output stays within the
 * model's context window. Only ever reduces; never raises or invents a value.
 *
 * Returns `requestedMaxTokens` unchanged when `contextWindow` is undefined or
 * <= 0 (unknown window → pass-through rather than a guess).
 */
export function clampMaxTokensToContext(args: {
	requestedMaxTokens: number;
	contextWindow: number | undefined;
	estimatedPromptTokens: number;
	reserveTokens?: number;
}): number {
	const { requestedMaxTokens, contextWindow, estimatedPromptTokens } = args;
	if (contextWindow === undefined || contextWindow <= 0) return requestedMaxTokens;
	const reserve = args.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
	const budget = Math.max(1, contextWindow - estimatedPromptTokens - reserve);
	return Math.min(requestedMaxTokens, budget);
}

/**
 * Estimate prompt token count using the byte heuristic `(bytes + 3) >> 2`
 * (identical formula to packages/agent/src/tokenizer.ts). Counts the system
 * prompt, each message's serialized content (text, images, thinking, tool
 * calls, and tool-result text/images), and serialized tools. Adds a fixed
 * per-image estimate for image blocks.
 */
export function estimatePromptTokens(
	systemPrompt: string | undefined,
	messages: readonly Message[],
	tools?: readonly unknown[],
): number {
	let tokens = 0;

	if (systemPrompt) {
		tokens += estimateTextTokens(systemPrompt);
	}

	for (const message of messages) {
		const content = message.content;
		if (typeof content === "string") {
			tokens += estimateTextTokens(content);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === "text") {
					tokens += estimateTextTokens(block.text);
				} else if (block.type === "image") {
					tokens += IMAGE_TOKEN_ESTIMATE;
				} else if (block.type === "thinking") {
					tokens += estimateTextTokens(block.thinking);
				} else if (block.type === "toolCall") {
					tokens += estimateTextTokens(JSON.stringify({ name: block.name, arguments: block.arguments }));
				}
			}
		}
	}

	if (tools && tools.length > 0) {
		tokens += estimateTextTokens(JSON.stringify(tools));
	}

	return tokens;
}

function estimateTextTokens(text: string): number {
	return (Buffer.byteLength(text, "utf-8") + 3) >> 2;
}
