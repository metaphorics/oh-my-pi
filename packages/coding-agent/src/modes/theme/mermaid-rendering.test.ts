import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	Container,
	Image,
	ImageBudget,
	ImageProtocol,
	Markdown,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import { buildSystemPrompt } from "../../system-prompt";
import { AssistantMessageComponent } from "../components/assistant-message";
import { type AssistantMessageContext, createAssistantMessageComponent } from "../utils/interactive-context-helpers";
import * as nomnomlCache from "./nomnoml-cache";
import {
	getMarkdownTheme,
	getThemeByName,
	setMarkdownMermaidRendering,
	setMarkdownNomnomlRendering,
	setThemeInstance,
} from "./theme";

const workspaceTree = {
	rootPath: "/tmp/project",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const originalImageProtocol = TERMINAL.imageProtocol;
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function createAssistantMessage(markdown: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: markdown }],
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

class RecordingImageBudget extends ImageBudget {
	readonly keys: Array<string | undefined> = [];

	override acquireId(key?: string): number {
		this.keys.push(key);
		return super.acquireId(key);
	}
}

function createLiveContext(
	showImages: boolean,
	budget: ImageBudget,
	requestRender: () => void,
): AssistantMessageContext & { settings: Settings } {
	return {
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: true,
		settings: Settings.isolated({ "terminal.showImages": showImages }),
		ui: { imageBudget: budget, requestRender },
		viewSession: { extensionRunner: undefined },
	};
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("theme unavailable");
	setThemeInstance(theme);
});

afterEach(() => {
	setMarkdownMermaidRendering(true);
	setMarkdownNomnomlRendering("off");
	setTerminalImageProtocol(originalImageProtocol);
	vi.restoreAllMocks();
});

describe("Mermaid rendering setting", () => {
	it("removes the Mermaid prompt note when rendering is disabled", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			renderMermaid: false,
			contextFiles: [],
			skills: [],
			toolNames: [],
			workspaceTree,
		});

		expect(systemPrompt.join("\n")).not.toContain("```mermaid");
	});

	it("falls back to a highlighted code fence when rendering is disabled", () => {
		setMarkdownMermaidRendering(false);

		const markdown = new Markdown("```mermaid\ngraph TD\n  A --> B\n```", 0, 0, getMarkdownTheme());
		const lines = stripAnsi(markdown.render(80).join("\n"));

		expect(lines).toContain("```mermaid");
		expect(lines).toContain("graph TD");
		expect(lines).toContain("-->");
	});

	it("uses the Nomnoml prompt hint instead of Mermaid when Nomnoml rendering is enabled", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			renderMermaid: true,
			renderNomnoml: true,
			contextFiles: [],
			skills: [],
			toolNames: [],
			workspaceTree,
		});
		const prompt = systemPrompt.join("\n");

		expect(prompt).toContain("```nomnoml");
		expect(prompt).not.toContain("```mermaid");
	});

	it("exposes Nomnoml ASCII fallback in SVG mode and renders Mermaid as code", () => {
		setMarkdownMermaidRendering(true);
		setMarkdownNomnomlRendering("svg");

		const theme = getMarkdownTheme();
		const ascii = theme.resolveNomnomlAscii?.("[A] -> [B]", 80);
		expect(ascii).toContain("A");
		expect(ascii).toContain("B");

		const nomnoml = stripAnsi(new Markdown("```nomnoml\n[A] -> [B]\n```", 0, 0, theme).render(80).join("\n"));
		expect(nomnoml).not.toContain("```nomnoml");
		expect(nomnoml).toContain("A");
		expect(nomnoml).toContain("B");

		const mermaid = stripAnsi(
			new Markdown("```mermaid\ngraph TD\n  A --> B\n```", 0, 0, theme).render(80).join("\n"),
		);
		expect(mermaid).toContain("```mermaid");
		expect(mermaid).toContain("graph TD");
	});

	for (const [style, source] of [
		["built-in", "[<hidden> secret]"],
		["custom", "#.ghost: visual=hidden\n[<ghost> secret]"],
	] as const) {
		it(`replaces all-hidden ${style} nomnoml fences without leaking source`, () => {
			setMarkdownNomnomlRendering("ascii");

			const theme = getMarkdownTheme();
			const ascii = theme.resolveNomnomlAscii?.(source, 80);
			expect(ascii).toBe("");
			expect(ascii).not.toBeNull();

			const rendered = stripAnsi(
				new Markdown(`\`\`\`nomnoml\n${source}\n\`\`\``, 0, 0, theme).render(80).join("\n"),
			);
			expect(rendered).not.toContain("secret");
			expect(rendered).not.toContain("```nomnoml");
			expect(rendered).not.toContain("```");
			expect(rendered).not.toContain("[<hidden>");
			expect(rendered).not.toContain("visual=hidden");
		});
	}
});

describe("Nomnoml SVG assistant rendering", () => {
	it("keeps ASCII fallback when the terminal has no image protocol", () => {
		setMarkdownNomnomlRendering("svg");
		setTerminalImageProtocol(null);
		const rasterSpy = spyOn(nomnomlCache, "resolveNomnomlPng").mockResolvedValue(TINY_PNG);

		const component = new AssistantMessageComponent(createAssistantMessage("```nomnoml\n[A] -> [B]\n```"));
		const rendered = stripAnsi(component.render(120).join("\n"));

		expect(rasterSpy).not.toHaveBeenCalled();
		expect(rendered).toContain("A");
		expect(rendered).toContain("B");
		expect(rendered).not.toContain("[Image:");
	});

	it("does not rasterize nomnoml fences nested inside an outer code fence", () => {
		setMarkdownNomnomlRendering("svg");
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const rasterSpy = spyOn(nomnomlCache, "resolveNomnomlPng").mockResolvedValue(TINY_PNG);

		const component = new AssistantMessageComponent(
			createAssistantMessage("````markdown\n```nomnoml\n[A] -> [B]\n```\n````"),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));

		expect(rasterSpy).not.toHaveBeenCalled();
		expect(rendered).toContain("```nomnoml");
	});

	it("uses unique image placement keys for repeated nomnoml sources", async () => {
		setMarkdownNomnomlRendering("svg");
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const rasterSpy = spyOn(nomnomlCache, "resolveNomnomlPng").mockResolvedValue(TINY_PNG);
		const imageUpdated = Promise.withResolvers<void>();
		const budget = new RecordingImageBudget(10);

		new AssistantMessageComponent(
			createAssistantMessage("```nomnoml\n[A] -> [B]\n```\n\n```nomnoml\n[A] -> [B]\n```"),
			false,
			imageUpdated.resolve,
			[],
			budget,
		);
		await imageUpdated.promise;

		expect(rasterSpy).toHaveBeenCalledTimes(1);
		expect(budget.keys).toHaveLength(2);
		expect(new Set(budget.keys).size).toBe(2);
		expect(budget.keys.every(key => key?.startsWith("nomnoml:"))).toBe(true);
	});

	it("uses unique image placement keys for nomnoml sources in separate content blocks", async () => {
		setMarkdownNomnomlRendering("svg");
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const rasterSpy = spyOn(nomnomlCache, "resolveNomnomlPng").mockResolvedValue(TINY_PNG);
		const imageUpdated = Promise.withResolvers<void>();
		const budget = new RecordingImageBudget(10);
		const fence = "```nomnoml\n[A] -> [B]\n```";
		const message = createAssistantMessage(fence);
		message.content = [
			{ type: "text", text: fence },
			{ type: "text", text: fence },
		];
		new AssistantMessageComponent(message, false, imageUpdated.resolve, [], budget);
		await imageUpdated.promise;
		expect(rasterSpy).toHaveBeenCalledTimes(1);
		expect(budget.keys).toHaveLength(2);
		expect(new Set(budget.keys).size).toBe(2);
	});

	it("uses unique image placement keys for identical nomnoml sources across assistant turns", async () => {
		setMarkdownNomnomlRendering("svg");
		setTerminalImageProtocol(ImageProtocol.Kitty);
		spyOn(nomnomlCache, "resolveNomnomlPng").mockResolvedValue(TINY_PNG);
		const firstUpdated = Promise.withResolvers<void>();
		const secondUpdated = Promise.withResolvers<void>();
		const budget = new RecordingImageBudget(10);
		const fence = "```nomnoml\n[A] -> [B]\n```";
		new AssistantMessageComponent(createAssistantMessage(fence), false, firstUpdated.resolve, [], budget);
		new AssistantMessageComponent(createAssistantMessage(fence), false, secondUpdated.resolve, [], budget);
		await Promise.all([firstUpdated.promise, secondUpdated.promise]);
		expect(budget.keys).toHaveLength(2);
		expect(new Set(budget.keys).size).toBe(2);
	});

	it("suppresses nomnoml images when showImages is false", async () => {
		setMarkdownNomnomlRendering("svg");
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const rasterSpy = spyOn(nomnomlCache, "resolveNomnomlPng").mockResolvedValue(TINY_PNG);
		const budget = new RecordingImageBudget(10);
		const fence = "```nomnoml\n[A] -> [B]\n```";
		const component = new AssistantMessageComponent(
			createAssistantMessage(fence),
			false,
			undefined,
			[],
			budget,
			true,
			false,
		);
		// Give any accidental async queue a turn to fire before asserting.
		await Promise.resolve();
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rasterSpy).not.toHaveBeenCalled();
		expect(budget.keys).toHaveLength(0);
		expect(rendered).toContain("A");
		expect(rendered).toContain("B");
		expect(rendered).not.toContain("[Image:");
	});

	it("propagates terminal.showImages through the live assistant helper", async () => {
		setMarkdownNomnomlRendering("svg");
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const rasterResult = Promise.withResolvers<string>();
		const rasterSpy = spyOn(nomnomlCache, "resolveNomnomlPng").mockReturnValue(rasterResult.promise);
		const budget = new RecordingImageBudget(10);
		const requestRender = vi.fn();
		const ctx = createLiveContext(false, budget, requestRender);
		const fence = "```nomnoml\n[A] -> [B]\n```";
		const component = createAssistantMessageComponent(ctx, createAssistantMessage(fence));

		rasterResult.resolve(TINY_PNG);
		await rasterResult.promise;
		await Promise.resolve();
		const rendered = stripAnsi(component.render(120).join("\n"));

		expect(rasterSpy).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
		expect(budget.keys).toHaveLength(0);
		expect(rendered).toContain("A");
		expect(rendered).toContain("B");
		expect(rendered).not.toContain("[Image:");
	});

	it("turns images on for an existing live component after invalidation", async () => {
		setMarkdownNomnomlRendering("svg");
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const rasterSpy = spyOn(nomnomlCache, "resolveNomnomlPng").mockResolvedValue(TINY_PNG);
		const budget = new RecordingImageBudget(10);
		const imageUpdated = Promise.withResolvers<void>();
		const ctx = createLiveContext(false, budget, imageUpdated.resolve);
		const message = createAssistantMessage("```nomnoml\n[A] -> [B]\n```");
		const component = createAssistantMessageComponent(ctx, message);

		ctx.settings.override("terminal.showImages", true);
		component.invalidate();
		await imageUpdated.promise;
		await Promise.resolve();
		budget.beginPass();
		const rendered = component.render(120).join("\n");
		budget.endPass();

		expect(rasterSpy).toHaveBeenCalledTimes(1);
		expect(budget.keys).toHaveLength(1);
		expect(rendered).toContain("\x1b_G");
	});

	it("preserves non-PNG read images without converting or rendering them while images are off", async () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const budget = new RecordingImageBudget(10);
		const imageUpdated = Promise.withResolvers<void>();
		const onImageUpdate = vi.fn(() => imageUpdated.resolve());
		let showImages = false;
		const component = new AssistantMessageComponent(
			createAssistantMessage("Read image"),
			false,
			onImageUpdate,
			[],
			budget,
			true,
			() => showImages,
		);
		component.setToolResultImages("read-jpeg", [{ type: "image", data: TINY_PNG, mimeType: "image/jpeg" }]);
		await new Bun.Image(Buffer.from(TINY_PNG, "base64")).png().toBase64();
		await Promise.resolve();
		expect(onImageUpdate).not.toHaveBeenCalled();

		const hidden = stripAnsi(component.render(120).join("\n"));
		expect(hidden).toContain("Read image");
		expect(hidden).not.toContain("[Image:");
		expect(budget.keys).toEqual([]);

		showImages = true;
		component.refreshImagePolicy();
		await imageUpdated.promise;
		expect(onImageUpdate).toHaveBeenCalledTimes(1);
		await Promise.resolve();
		budget.beginPass();
		const restored = component.render(120).join("\n");
		budget.endPass();
		expect(restored).toContain("\x1b_G");
		expect(budget.keys.at(-1)).toMatch(/^assistant-tool:am\d+:read-jpeg:0$/);
	});

	it("turns images off for an existing live component on update", async () => {
		setMarkdownNomnomlRendering("svg");
		setTerminalImageProtocol(ImageProtocol.Kitty);
		spyOn(nomnomlCache, "resolveNomnomlPng").mockResolvedValue(TINY_PNG);
		const budget = new RecordingImageBudget(10);
		const imageUpdated = Promise.withResolvers<void>();
		const ctx = createLiveContext(true, budget, imageUpdated.resolve);
		const message = createAssistantMessage("```nomnoml\n[A] -> [B]\n```");
		const component = createAssistantMessageComponent(ctx, message);
		await imageUpdated.promise;
		await Promise.resolve();

		budget.beginPass();
		const initial = component.render(120).join("\n");
		budget.endPass();
		const placementKey = budget.keys.at(-1);
		if (!placementKey) throw new Error("Expected a Nomnoml placement key");
		const initialId = budget.acquireId(placementKey);
		expect(initial).toContain("\x1b_G");
		expect(budget.takeTransmits()).toHaveLength(1);
		const genericId = budget.acquireId("generic-tool-image");
		budget.enqueueTransmit(genericId, "generic-transmit");
		expect(budget.takeTransmits()).toEqual(["generic-transmit"]);

		ctx.settings.override("terminal.showImages", false);
		component.refreshImagePolicy();
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(budget.takePurgeIds()).toEqual([initialId]);
		expect(budget.acquireId("generic-tool-image")).toBe(genericId);
		expect(budget.shouldTransmit(genericId)).toBe(false);
		expect(rendered).toContain("A");
		expect(rendered).toContain("B");
		expect(rendered).not.toContain("\x1b_G");
		expect(rendered).not.toContain("[Image:");
		const imageChildren = component.children.flatMap(child =>
			child instanceof Container ? child.children.filter(grandchild => grandchild instanceof Image) : [],
		);
		expect(imageChildren).toEqual([]);

		component.refreshImagePolicy();
		expect(budget.takePurgeIds()).toEqual([]);

		ctx.settings.override("terminal.showImages", true);
		component.refreshImagePolicy();
		budget.beginPass();
		const restored = component.render(120).join("\n");
		budget.endPass();
		const restoredId = budget.acquireId(placementKey);
		expect(restored).toContain("\x1b_G");
		expect(restoredId).not.toBe(initialId);
		expect(budget.takeTransmits()).toHaveLength(1);
	});

	it("resolves budget fallbacks at the effective image width", async () => {
		setMarkdownNomnomlRendering("svg");
		setTerminalImageProtocol(ImageProtocol.Kitty);
		spyOn(nomnomlCache, "resolveNomnomlPng").mockResolvedValue(TINY_PNG);
		const asciiSpy = spyOn(nomnomlCache, "resolveNomnomlAscii");
		const budget = new RecordingImageBudget(1);
		let updates = 0;
		const loaded = Promise.withResolvers<void>();
		const onUpdate = () => {
			updates += 1;
			if (updates === 2) loaded.resolve();
		};
		const source = "[Alpha] -> [Beta]";
		const older = new AssistantMessageComponent(
			createAssistantMessage(`\`\`\`nomnoml\n${source}\n\`\`\``),
			false,
			onUpdate,
			[],
			budget,
		);
		const newer = new AssistantMessageComponent(
			createAssistantMessage("```nomnoml\n[New] -> [Diagram]\n```"),
			false,
			onUpdate,
			[],
			budget,
		);
		await loaded.promise;
		await Promise.resolve();

		let narrow = "";
		for (let pass = 0; pass < 2; pass++) {
			budget.beginPass();
			narrow = stripAnsi(older.render(10).join("\n"));
			newer.render(10);
			budget.endPass();
		}
		expect(asciiSpy).toHaveBeenCalledWith(source, 8);
		expect(narrow).toContain("Alpha");
		expect(narrow).toContain("Beta");
		expect(narrow).not.toContain(source);
		expect(narrow).not.toContain("```nomnoml");
		expect(narrow.split("\n").every(line => Bun.stringWidth(line) <= 8)).toBe(true);

		budget.beginPass();
		const tooNarrow = stripAnsi(older.render(6).join("\n"));
		newer.render(6);
		budget.endPass();
		expect(asciiSpy).toHaveBeenCalledWith(source, 4);
		expect(tooNarrow).not.toContain("Alpha");
		expect(tooNarrow).not.toContain("Beta");
		expect(tooNarrow).not.toContain(source);
		expect(tooNarrow).not.toContain("┌");
		expect(tooNarrow.replace(/\s/g, "")).toContain("[Nomnomldiagram]");
	});
	it("renders budget-demoted hidden-label diagrams without leaking source at narrow width", async () => {
		setMarkdownNomnomlRendering("svg");
		setTerminalImageProtocol(ImageProtocol.Kitty);
		spyOn(nomnomlCache, "resolveNomnomlPng").mockResolvedValue(TINY_PNG);
		const budget = new RecordingImageBudget(1);
		let updates = 0;
		const loaded = Promise.withResolvers<void>();
		const onUpdate = () => {
			updates += 1;
			if (updates === 2) loaded.resolve();
		};
		const source =
			"[Public] -> [<hidden> built-in-secret]\n[Public] -> [<ghost> custom-secret]\n#.ghost: visual=hidden";
		const older = new AssistantMessageComponent(
			createAssistantMessage(`\`\`\`nomnoml\n${source}\n\`\`\``),
			false,
			onUpdate,
			[],
			budget,
		);
		const newer = new AssistantMessageComponent(
			createAssistantMessage("```nomnoml\n[Other] -> [Diagram]\n```"),
			false,
			onUpdate,
			[],
			budget,
		);
		await loaded.promise;
		await Promise.resolve();

		let rendered = "";
		for (let pass = 0; pass < 2; pass++) {
			budget.beginPass();
			rendered = stripAnsi(older.render(20).join("\n"));
			newer.render(20);
			budget.endPass();
		}

		expect(rendered).toContain("Public");
		expect(rendered).not.toContain("built-in-secret");
		expect(rendered).not.toContain("custom-secret");
		expect(rendered).not.toContain("secret");
		expect(rendered).not.toContain("visual=hidden");
		expect(rendered).not.toContain("[<hidden>");
		expect(rendered).not.toContain("[Image:");
		expect(rendered).not.toContain("```");
		expect(rendered.split("\n").every(line => Bun.stringWidth(line) <= 18)).toBe(true);
	});

	it("falls back to a neutral label when ASCII cannot render after protocol loss", async () => {
		setMarkdownNomnomlRendering("svg");
		setTerminalImageProtocol(ImageProtocol.Kitty);
		spyOn(nomnomlCache, "resolveNomnomlPng").mockResolvedValue(TINY_PNG);
		const imageUpdated = Promise.withResolvers<void>();
		const source = "[broken\x1b[31m";
		const component = new AssistantMessageComponent(
			createAssistantMessage(`\`\`\`nomnoml\n${source}\n\`\`\``),
			false,
			imageUpdated.resolve,
		);
		await imageUpdated.promise;
		await Promise.resolve();

		setTerminalImageProtocol(null);
		const rendered = stripAnsi(component.render(12).join("\n"));
		expect(rendered).not.toContain("[broken");
		expect(rendered).not.toContain("[Image:");
		expect(rendered).not.toContain("\x1b");
		expect(rendered).toContain("Nomnoml");
		expect(rendered).toContain("diagram");
		expect(rendered.split("\n").every(line => Bun.stringWidth(line) <= 10)).toBe(true);
	});
});

describe("AssistantMessageComponent async disposal", () => {
	it("does not resurrect a Nomnoml image after dispose while raster is pending", async () => {
		setMarkdownNomnomlRendering("svg");
		setTerminalImageProtocol(ImageProtocol.Kitty);

		const raster = Promise.withResolvers<string>();
		spyOn(nomnomlCache, "resolveNomnomlPng").mockReturnValue(raster.promise);

		const budget = new RecordingImageBudget(10);
		const requestRender = vi.fn();
		const ctx = createLiveContext(true, budget, requestRender);
		const message = createAssistantMessage("```nomnoml\n[A] -> [B]\n```");
		const component = createAssistantMessageComponent(ctx, message);

		component.dispose();
		const contentContainer = component.children[1];
		if (!(contentContainer instanceof Container)) throw new Error("Expected content container");
		const childrenAfterDispose = contentContainer.children.slice();
		raster.resolve(TINY_PNG);
		await raster.promise;
		await Promise.resolve();

		expect(requestRender).not.toHaveBeenCalled();
		expect(budget.keys).toEqual([]);
		expect(contentContainer.children).toHaveLength(childrenAfterDispose.length);
		expect(contentContainer.children.every((child, index) => child === childrenAfterDispose[index])).toBe(true);
		expect(contentContainer.children.some(child => child instanceof Image)).toBe(false);
	});

	it("does not resurrect a Kitty tool image after dispose while conversion is pending", async () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);

		const conversion = Promise.withResolvers<string>();
		spyOn(Bun.Image.prototype, "toBase64").mockReturnValue(conversion.promise);

		const budget = new RecordingImageBudget(10);
		const requestRender = vi.fn();
		const ctx = createLiveContext(true, budget, requestRender);
		const message = createAssistantMessage("tool image");
		const component = createAssistantMessageComponent(ctx, message);
		component.setToolResultImages("read-1", [{ type: "image", data: TINY_PNG, mimeType: "image/jpeg" }]);

		component.dispose();
		const contentContainer = component.children[1];
		if (!(contentContainer instanceof Container)) throw new Error("Expected content container");
		const childrenAfterDispose = contentContainer.children.slice();
		conversion.resolve(TINY_PNG);
		await conversion.promise;
		await Promise.resolve();

		expect(requestRender).not.toHaveBeenCalled();
		expect(budget.keys).toEqual([]);
		expect(contentContainer.children).toHaveLength(childrenAfterDispose.length);
		expect(contentContainer.children.every((child, index) => child === childrenAfterDispose[index])).toBe(true);
		expect(contentContainer.children.some(child => child instanceof Image)).toBe(false);
	});

	it("ignores updateContent after dispose", async () => {
		setMarkdownNomnomlRendering("svg");
		setTerminalImageProtocol(ImageProtocol.Kitty);

		const raster = Promise.withResolvers<string>();
		const rasterSpy = spyOn(nomnomlCache, "resolveNomnomlPng").mockReturnValue(raster.promise);

		const budget = new RecordingImageBudget(10);
		const requestRender = vi.fn();
		const ctx = createLiveContext(true, budget, requestRender);
		const firstMessage = createAssistantMessage("```nomnoml\n[Old] -> [Old]\n```");
		const component = createAssistantMessageComponent(ctx, firstMessage);

		expect(rasterSpy).toHaveBeenCalledTimes(1);

		component.dispose();
		const contentContainer = component.children[1];
		if (!(contentContainer instanceof Container)) throw new Error("Expected content container");
		const childrenAfterDispose = contentContainer.children.slice();

		const secondMessage = createAssistantMessage("```nomnoml\n[New] -> [New]\n```");
		component.updateContent(secondMessage);

		expect(rasterSpy).toHaveBeenCalledTimes(1);
		expect(budget.keys).toEqual([]);
		expect(contentContainer.children).toHaveLength(childrenAfterDispose.length);
		expect(contentContainer.children.every((child, index) => child === childrenAfterDispose[index])).toBe(true);

		raster.resolve(TINY_PNG);
		await raster.promise;
		await Promise.resolve();

		expect(requestRender).not.toHaveBeenCalled();
		expect(budget.keys).toEqual([]);
	});

	it("ignores refreshImagePolicy after dispose", async () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);

		const conversion = Promise.withResolvers<string>();
		const toBase64Spy = spyOn(Bun.Image.prototype, "toBase64").mockReturnValue(conversion.promise);

		const budget = new RecordingImageBudget(10);
		const requestRender = vi.fn();
		const ctx = createLiveContext(false, budget, requestRender);
		const message = createAssistantMessage("tool image");
		const component = createAssistantMessageComponent(ctx, message);
		component.setToolResultImages("read-fresh", [{ type: "image", data: TINY_PNG, mimeType: "image/jpeg" }]);

		expect(toBase64Spy).not.toHaveBeenCalled();

		component.dispose();
		ctx.settings.override("terminal.showImages", true);
		component.refreshImagePolicy();

		expect(toBase64Spy).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
		expect(budget.keys).toEqual([]);
	});
});
