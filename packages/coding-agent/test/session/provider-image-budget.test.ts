import { describe, expect, it } from "bun:test";
import type { Context, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { clampProviderContextImages } from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";

const UMANS_MODEL = buildModel({
	id: "umans-glm-5.2",
	name: "umans-glm-5.2",
	api: "anthropic-messages",
	provider: "umans",
	baseUrl: "https://api.code.umans.ai",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
});

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

function imageData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") data.push(part.data);
		}
	}
	return data;
}

function textData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (typeof message.content === "string") {
			data.push(message.content);
			continue;
		}
		for (const part of message.content) {
			if (part.type === "text") data.push(part.text);
		}
	}
	return data;
}

describe("provider context image budgets", () => {
	it("drops oldest images above the active provider cap while preserving text", () => {
		const context: Context = {
			systemPrompt: ["system"],
			tools: [],
			messages: Array.from({ length: 31 }, (_, index) => ({
				role: "user",
				content: [text(`text-${index}`), image(`image-${index}`)],
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);

		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `image-${index + 21}`));
		expect(textData(clamped)).toEqual(Array.from({ length: 31 }, (_, index) => `text-${index}`));
		expect(clamped).not.toBe(context);
		expect(imageData(context)).toEqual(Array.from({ length: 31 }, (_, index) => `image-${index}`));
	});

	it("keeps image-only tool results meaningful when every image block is dropped", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 11 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "inspect_image",
				content: [image(`image-${index}`)],
				isError: false,
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);
		const firstMessage = clamped.messages[0];

		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `image-${index + 1}`));
		expect(firstMessage?.role).toBe("toolResult");
		expect(firstMessage?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("preserves context identity when the provider cap is not exceeded", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("ok"), ...Array.from({ length: 10 }, (_, index) => image(`image-${index}`))],
					timestamp: 1,
				},
			],
		};

		expect(clampProviderContextImages(context, UMANS_MODEL)).toBe(context);
	});

	it("compensates for undroppable assistant images by dropping extra droppable ones", () => {
		// 1 assistant image (oldest) + 11 user images = 12 total, cap 10.
		// The assistant image cannot be rewritten, so 2 droppable user images
		// must be dropped to land the retained total exactly at the cap.
		const assistantUsage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "assistant",
					content: [image("assistant-image")],
					timestamp: 0,
					stopReason: "stop",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: assistantUsage,
				},
				...Array.from({ length: 11 }, (_, index) => ({
					role: "user" as const,
					content: [image(`image-${index}`)],
					timestamp: index + 1,
				})),
			],
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);

		// Assistant image retained untouched; the 2 oldest user images dropped.
		expect(clamped.messages[0]).toBe(context.messages[0]);
		expect(imageData(clamped)).toEqual([
			"assistant-image",
			...Array.from({ length: 9 }, (_, index) => `image-${index + 2}`),
		]);
	});
});

const ANTHROPIC_MODEL = buildModel({
	id: "claude-sonnet-4-20250514",
	name: "claude-sonnet-4-20250514",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 16384,
});

/** Create an ImageContent whose decoded byte size (Math.floor(data.length * 3 / 4)) equals `decodedBytes`. */
function imageOfDecodedBytes(decodedBytes: number): ImageContent {
	const len = Math.ceil((decodedBytes * 4) / 3);
	return { type: "image", data: "A".repeat(len), mimeType: "image/png" };
}

const MIB = 1024 * 1024;

describe("transport image byte budget", () => {
	it("retains the newest image even when it alone exceeds the 24 MiB budget", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [{ role: "user", content: [imageOfDecodedBytes(25 * MIB)], timestamp: 1 }],
		};

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);
		expect(result).toBe(context);
	});

	it("elides oldest images first when aggregate exceeds budget", () => {
		// 3 images × 10 MiB = 30 MiB > 24 MiB budget. Oldest should be elided.
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("msg-0"), imageOfDecodedBytes(10 * MIB)], timestamp: 0 },
				{ role: "user", content: [text("msg-1"), imageOfDecodedBytes(10 * MIB)], timestamp: 1 },
				{ role: "user", content: [text("msg-2"), imageOfDecodedBytes(10 * MIB)], timestamp: 2 },
			],
		};

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);

		// Oldest image elided, replaced with placeholder.
		const first = result.messages[0];
		expect(first?.role).toBe("user");
		if (first?.role === "user") {
			expect(first.content).toEqual([
				text("msg-0"),
				{ type: "text", text: "[image omitted: transport image budget]" },
			]);
		}
		// Newer images retained.
		expect(imageData(result).length).toBe(2);
		// Text preserved.
		expect(textData(result)).toContain("msg-0");
		expect(textData(result)).toContain("msg-1");
		expect(textData(result)).toContain("msg-2");
	});

	it("counts assistant image bytes toward the budget but never elides them", () => {
		// user 5 MiB (oldest) + assistant 10 MiB + user 10 MiB (newest) = 25 MiB > 24 MiB.
		// Without the assistant bytes the total (15 MiB) would fit; with them the
		// oldest droppable image must be elided, while the assistant image stays.
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [imageOfDecodedBytes(5 * MIB)], timestamp: 0 },
				{
					role: "assistant",
					content: [imageOfDecodedBytes(10 * MIB)],
					timestamp: 1,
					stopReason: "stop",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
				{ role: "user", content: [imageOfDecodedBytes(10 * MIB)], timestamp: 2 },
			],
		};

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);

		const first = result.messages[0];
		expect(first?.role).toBe("user");
		if (first?.role === "user") {
			expect(first.content).toEqual([{ type: "text", text: "[image omitted: transport image budget]" }]);
		}
		// Assistant message untouched; newest user image retained.
		expect(result.messages[1]).toBe(context.messages[1]);
		expect(imageData(result).length).toBe(2);
	});

	it("composes count cap and byte cap", () => {
		// UMANS_MODEL has count cap 10. 12 images × 4 MiB = 48 MiB.
		// Count clamp drops 2 oldest → 10 remain (40 MiB).
		// Byte budget: newest to oldest accumulates 4,8,12,16,20,24,28>24 → elides 4 more.
		// Final: 6 images remain.
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 12 }, (_, i) => ({
				role: "user" as const,
				content: [text(`t-${i}`), imageOfDecodedBytes(4 * MIB)],
				timestamp: i,
			})),
		};

		const result = clampProviderContextImages(context, UMANS_MODEL);
		expect(imageData(result).length).toBe(6);
		// All text preserved.
		expect(textData(result).filter(t => t.startsWith("t-")).length).toBe(12);
	});

	it("collapses consecutive placeholders within one content array", () => {
		// 3 × 12 MiB in one message + 1 MiB newest elsewhere. Total = 37 MiB > 24 MiB.
		// Newest (1 MiB) retained; walking older: acc=1, +12=13, +12=25>24 → elided, +12=37>24 → elided.
		// Two consecutive images in the same message elided → collapse to one placeholder.
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [
						text("before"),
						imageOfDecodedBytes(12 * MIB),
						imageOfDecodedBytes(12 * MIB),
						imageOfDecodedBytes(12 * MIB),
						text("after"),
					],
					timestamp: 0,
				},
				{ role: "user", content: [imageOfDecodedBytes(1 * MIB)], timestamp: 1 },
			],
		};

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);
		const first = result.messages[0];
		expect(first?.role).toBe("user");
		if (first?.role === "user") {
			const parts = first.content as (TextContent | ImageContent)[];
			const placeholders = parts.filter(
				p => p.type === "text" && p.text === "[image omitted: transport image budget]",
			);
			expect(placeholders.length).toBe(1);
			const images = parts.filter(p => p.type === "image");
			expect(images.length).toBe(1);
		}
	});

	it("leaves non-image content byte-identical", () => {
		const context: Context = {
			systemPrompt: ["system prompt"],
			tools: [],
			messages: [
				{ role: "user", content: [text("hello"), text("world")], timestamp: 0 },
				{
					role: "assistant",
					content: [text("response")],
					timestamp: 1,
					stopReason: "stop",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			],
		};

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);
		expect(result).toBe(context);
	});

	it("returns the same object graph when under budget", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [imageOfDecodedBytes(5 * MIB)], timestamp: 0 },
				{ role: "user", content: [imageOfDecodedBytes(5 * MIB)], timestamp: 1 },
			],
		};
		// 10 MiB total < 24 MiB budget.

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);
		expect(result).toBe(context);
	});

	it("replaces elided tool-result images with the transport placeholder", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-0",
					toolName: "inspect_image",
					content: [imageOfDecodedBytes(20 * MIB)],
					isError: false,
					timestamp: 0,
				},
				{ role: "user", content: [imageOfDecodedBytes(10 * MIB)], timestamp: 1 },
			],
		};
		// Total: 30 MiB > 24 MiB. Newest = 10 MiB (retained). Oldest = 20 MiB: acc = 10 + 20 = 30 > 24 → elided.

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);
		const first = result.messages[0];
		expect(first?.role).toBe("toolResult");
		if (first?.role === "toolResult") {
			expect(first.content).toEqual([{ type: "text", text: "[image omitted: transport image budget]" }]);
		}
		expect(imageData(result).length).toBe(1);
	});
});
