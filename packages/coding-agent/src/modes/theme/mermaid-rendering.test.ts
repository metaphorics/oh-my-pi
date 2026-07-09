import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ImageBudget, ImageProtocol, Markdown, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import { buildSystemPrompt } from "../../system-prompt";
import { AssistantMessageComponent } from "../components/assistant-message";
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
});
