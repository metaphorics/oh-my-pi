import type {
	Context,
	DeveloperMessage,
	ImageContent,
	Model,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { providerImageBudget } from "@oh-my-pi/snapcompact";

const TOOL_RESULT_IMAGE_OMISSION: TextContent = {
	type: "text",
	text: "[image omitted: provider image limit]",
};

const TRANSPORT_IMAGE_BUDGET_BYTES = 24 * 1024 * 1024;

const TRANSPORT_IMAGE_OMISSION: TextContent = {
	type: "text",
	text: "[image omitted: transport image budget]",
};

interface ImageSlot {
	messageIndex: number;
	partIndex: number;
	bytes: number;
	/** Assistant-message images are counted but never rewritten. */
	droppable: boolean;
}

function slotKey(slot: ImageSlot): string {
	return `${slot.messageIndex}:${slot.partIndex}`;
}

/** Per-image elision plan resolved from one shared traversal. */
interface ImageBudgetPlan {
	/** Oldest → newest, carrying each image's decoded byte size. */
	slots: ImageSlot[];
	/** Original part indices dropped so the count fits the provider cap. */
	countElided: Set<string>;
	/** Original part indices elided under the aggregate byte budget. */
	byteElided: Set<string>;
}

/**
 * Single traversal collecting both the total image count and per-image slots
 * (oldest → newest) carrying their decoded byte size. Shared by the count and
 * byte clamps so neither re-walks the context.
 */
function collectImageStats(context: Context): { count: number; slots: ImageSlot[] } {
	let count = 0;
	const slots: ImageSlot[] = [];
	for (let mi = 0; mi < context.messages.length; mi++) {
		const message = context.messages[mi];
		if (!Array.isArray(message.content)) continue;
		const droppable = message.role !== "assistant";
		for (let pi = 0; pi < message.content.length; pi++) {
			const part = message.content[pi];
			if (part.type === "image") {
				count++;
				slots.push({ messageIndex: mi, partIndex: pi, bytes: Math.floor((part.data.length * 3) / 4), droppable });
			}
		}
	}
	return { count, slots };
}

/** Resolve the count + byte elision sets from one set of slots. The count clamp
 *  drops the oldest droppable images until the retained total fits the provider
 *  cap; assistant images count toward the total but are never rewritten, so
 *  extra droppable images are dropped to compensate (upstream parity). The byte
 *  clamp walks the survivors newest → oldest, always retaining the newest;
 *  assistant bytes still accumulate because they upload regardless. */
function planImageBudget(slots: ImageSlot[], limit: number): ImageBudgetPlan {
	const countElided = new Set<string>();
	const dropCount = Math.max(0, slots.length - limit);
	let drops = 0;
	for (const slot of slots) {
		if (drops >= dropCount) break;
		if (!slot.droppable) continue;
		countElided.add(slotKey(slot));
		drops++;
	}

	const byteElided = new Set<string>();
	// Only images that survive the count clamp count toward the byte budget.
	const survivors = slots.filter(s => !countElided.has(slotKey(s)));
	let accumulated = 0;
	// Newest (last) → oldest (first); the newest image is always retained.
	for (let i = survivors.length - 1; i >= 0; i--) {
		const slot = survivors[i];
		accumulated += slot.bytes;
		if (i === survivors.length - 1) continue;
		if (accumulated > TRANSPORT_IMAGE_BUDGET_BYTES && slot.droppable) {
			byteElided.add(slotKey(slot));
		}
	}

	return { slots, countElided, byteElided };
}

type ContentMessage = UserMessage | DeveloperMessage | ToolResultMessage;

/** Rewrite one content array per the elision plan. Count-dropped images are
 *  removed; byte-dropped images collapse into a single transport placeholder. */
function clampContentBudget(
	content: readonly (TextContent | ImageContent)[],
	entry: { count: Set<number>; byte: Set<number> },
): (TextContent | ImageContent)[] | undefined {
	let changed = false;
	const clamped: (TextContent | ImageContent)[] = [];
	for (let i = 0; i < content.length; i++) {
		const part = content[i];
		if (part.type === "image") {
			if (entry.count.has(i)) {
				changed = true;
				continue;
			}
			if (entry.byte.has(i)) {
				changed = true;
				if (clamped[clamped.length - 1] !== TRANSPORT_IMAGE_OMISSION) {
					clamped.push(TRANSPORT_IMAGE_OMISSION);
				}
				continue;
			}
		}
		clamped.push(part);
	}
	return changed ? clamped : undefined;
}

function clampContentMessage(
	message: ContentMessage,
	entry: { count: Set<number>; byte: Set<number> },
): ContentMessage {
	if (message.role === "toolResult") {
		// toolResult content is always an array of text/image blocks.
		const content = clampContentBudget(message.content, entry);
		if (!content) return message;
		if (content.length > 0) return { ...message, content };
		// All blocks dropped by the count clamp — keep the result meaningful.
		return { ...message, content: [TOOL_RESULT_IMAGE_OMISSION] };
	}
	if (!Array.isArray(message.content) || (entry.count.size === 0 && entry.byte.size === 0)) return message;
	const content = clampContentBudget(message.content, entry);
	return content ? { ...message, content } : message;
}

/** Drops oldest transient image blocks so outgoing vision requests fit the
 *  active provider's image cap, then enforces a 24 MiB aggregate decoded-image-
 *  byte budget on the remaining images. Both clamps share a single traversal. */
export function clampProviderContextImages(context: Context, model: Model): Context {
	if (!model.input.includes("image")) return context;
	const limit = providerImageBudget(model.provider);
	const { count, slots } = collectImageStats(context);
	// 0-1 images: the byte budget always retains the newest and has nothing
	// older to elide, and a single image never reaches a provider count cap (>=1).
	if (count <= 1) return context;

	const { countElided, byteElided } = planImageBudget(slots, limit);
	if (countElided.size === 0 && byteElided.size === 0) return context;

	const byMessage = new Map<number, { count: Set<number>; byte: Set<number> }>();
	const note = (key: string, kind: "count" | "byte") => {
		const [mi, pi] = key.split(":").map(Number);
		let entry = byMessage.get(mi);
		if (!entry) {
			entry = { count: new Set(), byte: new Set() };
			byMessage.set(mi, entry);
		}
		entry[kind].add(pi);
	};
	for (const key of countElided) note(key, "count");
	for (const key of byteElided) note(key, "byte");

	const messages = context.messages.map((message, mi) => {
		const entry = byMessage.get(mi);
		if (!entry) return message;
		switch (message.role) {
			case "user":
			case "developer":
			case "toolResult":
				return clampContentMessage(message, entry);
			case "assistant":
				return message;
		}
		return message;
	});
	return { ...context, messages };
}
