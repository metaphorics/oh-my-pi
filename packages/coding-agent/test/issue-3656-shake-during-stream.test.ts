import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import * as nomnomlCache from "@oh-my-pi/pi-coding-agent/modes/theme/nomnoml-cache";
import { initTheme, setMarkdownNomnomlRendering } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression for issue #3656 — running `/shake` (or any mid-stream rebuild)
 * while the LLM is still streaming used to wipe the in-flight assistant turn
 * from the chat. `rebuildChatFromMessages` clears `chatContainer` and replays
 * only committed `state.messages`; the agent's in-flight `streamMessage` and
 * its still-pending tool calls live OUTSIDE `state.messages` until
 * `message_end`, so the live `streamingComponent` and `pendingTools` entries
 * were detached and every subsequent `message_update`/`message_end` event
 * routed deltas into orphaned components that never re-rendered.
 *
 * The fix snapshots the live components before clear, re-appends them after
 * the historical replay, and restores the `pendingTools` map so streaming
 * continues into the same on-screen components.
 */
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const originalImageProtocol = TERMINAL.imageProtocol;
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function assistantWithNomnoml(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "```nomnoml\n[Old] -> [New]\n```" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage,
		timestamp: Date.now(),
	};
}

function assistantWithBash(command: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage,
		timestamp: Date.now(),
	};
}

describe("issue #3656 /shake mid-stream preserves the in-flight assistant turn", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-3656-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.stop();
		setMarkdownNomnomlRendering("off");
		setTerminalImageProtocol(originalImageProtocol);
		HistoryStorage.resetInstance();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function makeStreamingFixture(streaming = true): {
		streamingComponent: AssistantMessageComponent;
		pendingTool: ToolExecutionComponent;
	} {
		const streamingComponent = new AssistantMessageComponent();
		const pendingTool = new ToolExecutionComponent(
			"bash",
			{ command: "echo hi" },
			{},
			undefined,
			mode.ui,
			tempDir.path(),
			"call-1",
		);
		mode.chatContainer.addChild(streamingComponent);
		mode.chatContainer.addChild(pendingTool);
		mode.streamingComponent = streamingComponent;
		mode.streamingMessage = assistantWithBash("echo hi");
		mode.pendingTools.set("call-1", pendingTool);
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		return { streamingComponent, pendingTool };
	}

	it("keeps the streaming assistant component attached after a mid-stream rebuild", () => {
		const { streamingComponent } = makeStreamingFixture();

		mode.rebuildChatFromMessages();

		expect(mode.chatContainer.children).toContain(streamingComponent);
		expect(mode.streamingComponent).toBe(streamingComponent);
	});

	it("keeps in-flight tool components attached and tracked in pendingTools", () => {
		const { pendingTool } = makeStreamingFixture();

		mode.rebuildChatFromMessages();

		expect(mode.chatContainer.children).toContain(pendingTool);
		expect(mode.pendingTools.get("call-1")).toBe(pendingTool);
	});

	it("routes later streamed tool-call deltas into the preserved on-screen component", async () => {
		const { pendingTool } = makeStreamingFixture();
		const updateArgs = vi.spyOn(pendingTool, "updateArgs");

		mode.rebuildChatFromMessages();
		await mode.eventController.handleEvent({
			type: "message_update",
			message: assistantWithBash("echo after"),
		} as AgentSessionEvent);

		expect(mode.pendingTools.get("call-1")).toBe(pendingTool);
		expect(updateArgs).toHaveBeenCalledWith({ command: "echo after" }, "call-1");
	});

	it("re-appends in-flight components after the historical replay (live tail order)", () => {
		const { streamingComponent, pendingTool } = makeStreamingFixture();

		mode.rebuildChatFromMessages();

		const children = mode.chatContainer.children;
		const streamingIdx = children.indexOf(streamingComponent);
		const pendingIdx = children.indexOf(pendingTool);
		expect(streamingIdx).toBeGreaterThanOrEqual(0);
		expect(pendingIdx).toBeGreaterThan(streamingIdx);
	});

	it("uses the rendered view session when preserving a focused subagent stream", () => {
		const { streamingComponent, pendingTool } = makeStreamingFixture(false);
		Object.defineProperty(mode, "viewSession", {
			configurable: true,
			get: () => ({
				isStreaming: true,
				buildTranscriptSessionContext: () => ({ messages: [] }),
				getToolByName: () => undefined,
				sessionManager: { getCwd: () => tempDir.path() },
				retryAttempt: undefined,
			}),
		});

		mode.rebuildChatFromMessages();

		expect(mode.chatContainer.children).toContain(streamingComponent);
		expect(mode.chatContainer.children).toContain(pendingTool);
		expect(mode.pendingTools.get("call-1")).toBe(pendingTool);
	});

	it("disposes rebuilt Nomnoml placements exactly once and gives the replacement a fresh Kitty ID", async () => {
		setMarkdownNomnomlRendering("svg");
		setTerminalImageProtocol(ImageProtocol.Kitty);
		vi.spyOn(nomnomlCache, "resolveNomnomlPng").mockResolvedValue(tinyPng);
		Settings.instance.override("terminal.showImages", true);
		const message = assistantWithNomnoml();
		session.sessionManager.appendMessage(message);
		const budget = mode.ui.imageBudget;
		const acquireSpy = vi.spyOn(budget, "acquireId");
		const releaseSpy = vi.spyOn(budget, "release");
		const genericId = budget.acquireId("generic-tool-image");
		const imageUpdated = Promise.withResolvers<void>();
		mode.ui.requestRender = vi.fn(() => imageUpdated.resolve());

		mode.rebuildChatFromMessages();
		await imageUpdated.promise;
		const oldComponent = mode.chatContainer.children.find(child => child instanceof AssistantMessageComponent) as
			| AssistantMessageComponent
			| undefined;
		if (!oldComponent) throw new Error("Expected rebuilt historical assistant component");
		budget.beginPass();
		const oldRender = oldComponent.render(120).join("\n");
		budget.endPass();
		const oldAcquireIndex = acquireSpy.mock.calls.findIndex(
			([key]) => typeof key === "string" && /^nomnoml:[^:]+:am\d+:0:/.test(key),
		);
		const oldKey = acquireSpy.mock.calls[oldAcquireIndex]?.[0];
		const oldId = acquireSpy.mock.results[oldAcquireIndex]?.value as number | undefined;
		if (typeof oldKey !== "string" || oldId === undefined) throw new Error("Expected old Nomnoml placement");
		expect(oldRender).toContain("\x1b_G");
		expect(oldKey).toMatch(/^nomnoml:[^:]+:am\d+:0:/);
		expect(oldId).toBeGreaterThan(0);
		expect(budget.takeTransmits()).toHaveLength(1);
		releaseSpy.mockClear();
		acquireSpy.mockClear();

		const replacementUpdated = Promise.withResolvers<void>();
		mode.ui.requestRender = vi.fn(() => replacementUpdated.resolve());

		mode.rebuildChatFromMessages();
		await replacementUpdated.promise;
		const replacement = mode.chatContainer.children.find(child => child instanceof AssistantMessageComponent) as
			| AssistantMessageComponent
			| undefined;
		if (!replacement) throw new Error("Expected replacement historical assistant component");
		expect(replacement).not.toBe(oldComponent);
		expect(releaseSpy.mock.calls).toEqual([[oldKey]]);
		expect(budget.takePurgeIds()).toEqual([oldId]);
		expect(budget.acquireId("generic-tool-image")).toBe(genericId);

		budget.beginPass();
		const replacementRender = replacement.render(120).join("\n");
		budget.endPass();
		const replacementAcquireIndex = acquireSpy.mock.calls.findIndex(
			([key]) => typeof key === "string" && /^nomnoml:[^:]+:am\d+:0:/.test(key),
		);
		const replacementKey = acquireSpy.mock.calls[replacementAcquireIndex]?.[0];
		const replacementId = acquireSpy.mock.results[replacementAcquireIndex]?.value as number | undefined;
		if (typeof replacementKey !== "string" || replacementId === undefined) {
			throw new Error("Expected replacement Nomnoml placement");
		}
		expect(replacementRender).toContain("\x1b_G");
		expect(replacementKey).not.toBe(oldKey);
		expect(replacementId).toBeGreaterThan(0);
		expect(replacementId).not.toBe(oldId);

		oldComponent.dispose();
		oldComponent.dispose();
		expect(releaseSpy.mock.calls).toEqual([[oldKey]]);
	});

	it("does not preserve in-flight tracking when the session is idle (post-stream rebuilds reset cleanly)", () => {
		const streamingComponent = new AssistantMessageComponent();
		mode.chatContainer.addChild(streamingComponent);
		mode.streamingComponent = streamingComponent;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });

		mode.rebuildChatFromMessages();

		// Idle rebuilds (resume, /compact post-flush, theme overlay close) treat
		// `streamingComponent` as stale UI to discard — the chat must be redrawn
		// purely from committed messages.
		expect(mode.chatContainer.children).not.toContain(streamingComponent);
	});
});
