import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { ImageBudget, ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;
const originalImageProtocol = TERMINAL.imageProtocol;
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Read image" }],
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

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	const testTheme = await getThemeByName("dark");
	if (!testTheme) throw new Error("Failed to load dark theme for selector test");
	setThemeInstance(testTheme);
});

afterEach(() => {
	setTerminalImageProtocol(originalImageProtocol);
	vi.restoreAllMocks();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

describe("selector setting side effects", () => {
	it("refreshes the status line when git integration changes at runtime", () => {
		const updateSettings = vi.fn();
		const requestRender = vi.fn();
		const controller = new SelectorController({
			statusLine: { updateSettings },
			ui: { requestRender },
		} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		Settings.instance.override("git.enabled", false);
		controller.handleSettingChange("git.enabled", false);

		expect(updateSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				preset: Settings.instance.get("statusLine.preset"),
				leftSegments: Settings.instance.get("statusLine.leftSegments"),
				rightSegments: Settings.instance.get("statusLine.rightSegments"),
			}),
		);
		// The setting-change side effect is a single render request — the lazy
		// top-border provider rebuilds during paint (#4145).
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("invalidates the UI and requests a repaint when tui.tight changes", () => {
		const invalidate = vi.fn();
		const requestRender = vi.fn();
		const controller = new SelectorController({
			ui: { invalidate, requestRender },
		} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		controller.handleSettingChange("tui.tight", true);

		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("applies terminal.showImages to stored assistant read images through the real selector path", () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		Settings.instance.override("terminal.showImages", true);
		const budget = new ImageBudget(10);
		const assistant = new AssistantMessageComponent(assistantMessage(), false, undefined, [], budget, true, () =>
			Settings.instance.get("terminal.showImages"),
		);
		assistant.setToolResultImages("read-image", [{ type: "image", data: tinyPng, mimeType: "image/png" }]);
		const resetDisplay = vi.fn();
		const controller = new SelectorController({
			chatContainer: { children: [assistant] },
			ui: { resetDisplay },
		} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		budget.beginPass();
		const initial = assistant.render(100).join("\n");
		budget.endPass();
		const [initialTransmit] = budget.takeTransmits();
		expect(initial).toContain("\x1b_G");
		expect(initialTransmit).toContain("\x1b_G");
		const transmittedId = Number(initialTransmit?.match(/i=(\d+)/)?.[1]);
		expect(transmittedId).toBeGreaterThan(0);

		Settings.instance.override("terminal.showImages", false);
		controller.handleSettingChange("terminal.showImages", false);
		const hidden = stripVTControlCharacters(assistant.render(100).join("\n"));
		expect(hidden).toContain("Read image");
		expect(hidden).not.toContain("[Image:");
		expect(budget.takeTransmits()).toEqual([]);
		expect(budget.takePurgeIds()).toEqual([transmittedId]);

		Settings.instance.override("terminal.showImages", true);
		controller.handleSettingChange("terminal.showImages", true);
		budget.beginPass();
		const restored = assistant.render(100).join("\n");
		budget.endPass();
		const [restoredTransmit] = budget.takeTransmits();
		const restoredId = Number(restoredTransmit?.match(/i=(\d+)/)?.[1]);
		expect(restored).toContain("\x1b_G");
		expect(restoredId).toBeGreaterThan(0);
		expect(restoredId).not.toBe(transmittedId);
		expect(resetDisplay).toHaveBeenCalledTimes(2);
	});

	it("replaces malformed default retry fallback chains from the model selector action", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const settings = Settings.isolated({});
		settings.set("retry.fallbackChains", { default: "not-an-array" } as unknown as Record<string, string[]>);
		const fallback = buildModel({
			id: "retry-fallback-model",
			name: "retry-fallback-model",
			api: "ollama-chat",
			baseUrl: "https://example.com",
			reasoning: false,
			provider: "test",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1024,
		});
		const showStatus = vi.fn();
		const showError = vi.fn();
		const controller = new SelectorController({
			ui: { requestRender: vi.fn(), setFocus: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor: {},
			settings,
			session: {
				model: undefined,
				modelRegistry: {
					getAll: () => [fallback],
					getDiscoverableProviders: () => [],
				},
				scopedModels: [{ model: fallback }],
				getContextUsage: () => undefined,
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			keybindings: { getKeys: () => [] },
			showStatus,
			showError,
		} as unknown as ConstructorParameters<typeof SelectorController>[0]);
		let selector: { handleInput(input: string): void; render(width: number): string[] } | undefined;
		controller.showSelector = create => {
			const result = create(() => {});
			selector = result.component as typeof selector;
		};

		controller.showModelSelector();
		if (!selector) throw new Error("Expected model selector to be shown");
		selector.handleInput("\n");
		for (let attempt = 0; attempt < 20; attempt++) {
			const selectedLine = stripVTControlCharacters(selector.render(220).join("\n"))
				.split("\n")
				.find(line => {
					if (!line.includes("Set as DEFAULT retry fallback")) return false;
					const trimmed = line.trimStart();
					return trimmed.startsWith("❯") || trimmed.startsWith("▸") || trimmed.startsWith(">");
				});
			if (selectedLine) break;
			selector.handleInput("\x1b[B");
			if (attempt === 19) throw new Error("Default retry fallback action was not selectable");
		}
		selector.handleInput("\n");
		await Promise.resolve();

		expect(showError).not.toHaveBeenCalled();
		expect(settings.get("retry.fallbackChains")).toEqual({ default: ["test/retry-fallback-model"] });
		expect(showStatus).toHaveBeenCalledWith("Default fallback model: test/retry-fallback-model");
	});
});
