import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Markdown } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import { buildSystemPrompt } from "../../system-prompt";
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

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("theme unavailable");
	setThemeInstance(theme);
});

afterEach(() => {
	setMarkdownMermaidRendering(true);
	setMarkdownNomnomlRendering("off");
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
