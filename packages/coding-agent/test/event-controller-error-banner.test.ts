/**
 * EventController error-banner wiring.
 *
 * A turn that ends on a provider error (e.g. Anthropic's "Output blocked by
 * content filtering policy") must pin a persistent banner above the editor via
 * `ctx.showPinnedError`, and the banner must be cleared at the next turn's
 * `agent_start` via `ctx.clearPinnedError`. Aborts and normal stops must NOT
 * pin a banner.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { ErrorBannerComponent } from "@oh-my-pi/pi-coding-agent/modes/components/error-banner";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "draft" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	};
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

function createFixture(streamingMessage?: AssistantMessage) {
	const componentCalls: string[] = [];
	const streamingComponent = {
		updateContent: vi.fn(() => componentCalls.push("update")),
		setComplete: vi.fn(),
		markTranscriptBlockFinalized: vi.fn(),
		sealTranscriptBlock: vi.fn(() => componentCalls.push("seal")),
		setErrorPinned: vi.fn((pinned: boolean) => componentCalls.push(pinned ? "pin" : "unpin")),
		setHideThinkingBlock: vi.fn((hide: boolean) => componentCalls.push(`hide:${hide}`)),
		messagePersistenceKey: vi.fn(() => "test-persistence-key"),
		applyRetryRecovery: vi.fn(),
	};
	const showPinnedError = vi.fn();
	const clearPinnedError = vi.fn();
	const statusContainer = {
		clear: vi.fn(),
		disposeChildren: vi.fn(),
		addChild: vi.fn(),
	};

	const session = { isStreaming: false };
	const viewSession = { isStreaming: false, isTtsrAbortPending: false, retryAttempt: 0 };
	let hasDisplayableThinkingContent = false;
	const noteDisplayableThinkingContent = vi.fn((message: AssistantMessage) => {
		const hasThinking = message.content.some(
			content => content.type === "thinking" && content.thinking.trim() !== "",
		);
		if (!hasThinking || hasDisplayableThinkingContent) return false;
		hasDisplayableThinkingContent = true;
		return true;
	});
	const chatChildren: unknown[] = [];
	const chatContainer = {
		children: chatChildren,
		addChild: vi.fn((child: unknown) => {
			chatChildren.push(child);
		}),
		clear: vi.fn(() => {
			chatChildren.length = 0;
		}),
	};
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		settings: { get: vi.fn(() => false) },
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		ensureLoadingAnimation: vi.fn(),
		statusContainer,
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		editor: {},
		streamingComponent: streamingMessage ? streamingComponent : undefined,
		streamingMessage,
		chatContainer,
		proseOnlyThinking: true,
		pendingTools: new Map(),
		flushCompactionQueue: vi.fn(async () => {}),
		showPinnedError,
		clearPinnedError,
		showError: vi.fn(),
		showStatus: vi.fn(),
		noteDisplayableThinkingContent,
		get hasDisplayableThinkingContent() {
			return hasDisplayableThinkingContent;
		},
		get effectiveHideThinkingBlock() {
			return !hasDisplayableThinkingContent;
		},
		showWarning: vi.fn(),
		session,
		get viewSession() {
			return viewSession;
		},
		clearTransientSessionUi: () => {},
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	return { controller, ctx, showPinnedError, clearPinnedError, streamingComponent, componentCalls, chatChildren };
}

function makeAttachSessionStub(isStreaming = false) {
	let listener: ((event: AgentSessionEvent) => Promise<void> | void) | undefined;
	const session = {
		isStreaming,
		subscribe(fn: (event: AgentSessionEvent) => Promise<void> | void) {
			listener = fn;
			return () => {};
		},
	} as AgentSession;
	return {
		session,
		emit: async (event: AgentSessionEvent) => {
			if (!listener) throw new Error("session was not attached");
			await listener(event);
		},
	};
}

describe("EventController error banner", () => {
	it("pins the provider error above the editor when an assistant turn ends on stopReason error", async () => {
		const errorMessage = "Output blocked by content filtering policy";
		const message = makeAssistantMessage({ stopReason: "error", errorMessage });
		const { controller, showPinnedError, streamingComponent } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		expect(showPinnedError).toHaveBeenCalledTimes(1);
		expect(showPinnedError).toHaveBeenCalledWith(errorMessage);
		// The same error is mirrored in the banner, so the transcript's inline
		// `Error: …` line is suppressed to avoid a duplicate render.
		expect(streamingComponent.setErrorPinned).toHaveBeenCalledWith(true);
	});

	it("restores the transcript inline error when the next turn starts", async () => {
		const errorMessage = "Output blocked by content filtering policy";
		const message = makeAssistantMessage({ stopReason: "error", errorMessage });
		const { controller, clearPinnedError, streamingComponent } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		streamingComponent.setErrorPinned.mockClear();

		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);

		expect(clearPinnedError).toHaveBeenCalledTimes(1);
		expect(streamingComponent.setErrorPinned).toHaveBeenCalledWith(false);
	});

	it("restores the inline error before sealing at the next assistant message", async () => {
		const message = makeAssistantMessage({ stopReason: "error", errorMessage: "blocked" });
		const nextMessage = makeAssistantMessage({ content: [] });
		const { controller, streamingComponent, componentCalls } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		componentCalls.length = 0;

		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		expect(streamingComponent.sealTranscriptBlock).not.toHaveBeenCalled();
		await controller.handleEvent({ type: "message_start", message: nextMessage } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);

		expect(componentCalls).toEqual(["unpin", "seal"]);
	});

	it("preserves error pinning when a transcript rebuild replaces the assistant", async () => {
		const message = makeAssistantMessage({ stopReason: "error", errorMessage: "blocked" });
		const { controller } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		const rebuilt = new AssistantMessageComponent(message);
		controller.inheritAssistantAwaitingSeal(rebuilt);
		expect(Bun.stripANSI(rebuilt.render(120).join("\n"))).not.toContain("Error: blocked");

		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		expect(Bun.stripANSI(rebuilt.render(120).join("\n"))).toContain("Error: blocked");
		await controller.handleEvent({ type: "message_start", message: makeAssistantMessage({ content: [] }) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		expect(rebuilt.isTranscriptBlockSealed()).toBe(true);
	});

	it("seals a rebuilt predecessor before replacing it at message end", async () => {
		const first = makeAssistantMessage();
		const next = makeAssistantMessage({ content: [] });
		const { controller, ctx } = createFixture(first);

		await controller.handleEvent({ type: "message_end", message: first } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		await controller.handleEvent({ type: "message_start", message: next } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		const rebuiltPredecessor = new AssistantMessageComponent(first);
		controller.inheritAssistantAwaitingSeal(rebuiltPredecessor);
		expect(rebuiltPredecessor.isTranscriptBlockSealed()).toBe(false);
		expect(ctx.streamingComponent).toBeInstanceOf(AssistantMessageComponent);

		await controller.handleEvent({ type: "message_end", message: next } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		expect(rebuiltPredecessor.isTranscriptBlockSealed()).toBe(true);
	});

	it("drops stale assistant seal and pin anchors when transcript anchors reset", async () => {
		const message = makeAssistantMessage({ stopReason: "error", errorMessage: "blocked" });
		const { controller, streamingComponent } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		streamingComponent.sealTranscriptBlock.mockClear();
		streamingComponent.setErrorPinned.mockClear();

		controller.resetTranscriptAnchors();
		await controller.handleEvent({
			type: "message_start",
			message: makeAssistantMessage({ content: [] }),
		} as Extract<AgentSessionEvent, { type: "message_start" }>);

		expect(streamingComponent.sealTranscriptBlock).not.toHaveBeenCalled();
		expect(streamingComponent.setErrorPinned).not.toHaveBeenCalledWith(false);
	});

	it("attaches mid-turn and routes the first orphaned assistant update to one transcript block", async () => {
		const { controller: eventController, ctx, chatChildren } = createFixture();
		const main = makeAttachSessionStub();
		const worker = makeAttachSessionStub(true);
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: worker.session,
			status: "running",
		});
		const lifecycle = new AgentLifecycleManager(registry);
		const update = makeAssistantMessage({
			content: [{ type: "text", text: "partial after attach" }],
		});
		const rebuilt = new AssistantMessageComponent(update);
		Object.assign(ctx, {
			session: main.session,
			unsubscribe: vi.fn(),
			eventController,
			clearTransientSessionUi: vi.fn(),
			renderInitialMessages: vi.fn(() => {
				ctx.chatContainer.clear();
				ctx.chatContainer.addChild(rebuilt);
				eventController.inheritAssistantAwaitingSeal(rebuilt);
			}),
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
		});
		Object.assign(ctx.statusLine, { setSession: vi.fn() });
		const focusController = new SessionFocusController(ctx, registry, () => lifecycle);

		await focusController.focusAgent("Worker");
		await worker.emit({
			type: "message_update",
			message: update,
			assistantMessageEvent: { type: "text_delta", delta: "partial after attach" },
		} as Extract<AgentSessionEvent, { type: "message_update" }>);

		expect(chatChildren).toHaveLength(1);
		expect(chatChildren[0]).toBe(rebuilt);
		expect(ctx.streamingComponent).toBe(rebuilt);
		expect(ctx.streamingMessage).toBe(update);
		// Historical rebuild finalizes the assistant; resume must re-open it so the
		// live-region seam pins on the streaming block until message_end.
		expect(rebuilt.isTranscriptBlockFinalized()).toBe(false);
		expect(rebuilt.getTranscriptBlockSettledRows()).toBe(0);

		await worker.emit({
			type: "message_end",
			message: update,
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		expect(rebuilt.isTranscriptBlockFinalized()).toBe(true);
	});

	it("clears retryable thinking-loop banners without restoring the dropped inline error", async () => {
		const errorMessage = "loop guard stopped repeated reasoning";
		const message = makeAssistantMessage({
			stopReason: "error",
			errorMessage,
			errorId: AIError.create(AIError.Flag.ThinkingLoop),
		});
		const { controller, clearPinnedError, streamingComponent } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		clearPinnedError.mockClear();
		streamingComponent.setErrorPinned.mockClear();

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 2,
			delayMs: 0,
			errorMessage,
			errorId: AIError.create(AIError.Flag.ThinkingLoop),
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);

		expect(clearPinnedError).toHaveBeenCalledTimes(1);
		expect(streamingComponent.setErrorPinned).not.toHaveBeenCalledWith(false);
		await controller.handleEvent({
			type: "auto_retry_end",
			success: true,
			attempt: 1,
		} as Extract<AgentSessionEvent, { type: "auto_retry_end" }>);
	});

	it("does not pin a banner for a normal assistant stop", async () => {
		const message = makeAssistantMessage({ stopReason: "stop" });
		const { controller, showPinnedError } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		expect(showPinnedError).not.toHaveBeenCalled();
	});

	it("does not pin a banner for an aborted assistant turn", async () => {
		const message = makeAssistantMessage({ stopReason: "aborted", errorMessage: "Operation aborted" });
		const { controller, showPinnedError } = createFixture(message);
		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		expect(showPinnedError).not.toHaveBeenCalled();
	});

	it("clears the pinned banner when the next turn starts", async () => {
		const { controller, clearPinnedError } = createFixture();

		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);

		expect(clearPinnedError).toHaveBeenCalledTimes(1);
	});
});

describe("EventController thinking visibility", () => {
	it("shows the first observed thinking delta on the active streaming component", async () => {
		const initial = makeAssistantMessage({ content: [] });
		const message = makeAssistantMessage({
			content: [{ type: "thinking", thinking: "server-side reasoning" }],
		});
		const { controller, ctx } = createFixture();

		await controller.handleEvent({
			type: "message_start",
			message: initial,
		} as Extract<AgentSessionEvent, { type: "message_start" }>);
		const component = ctx.streamingComponent;
		if (!(component instanceof AssistantMessageComponent)) {
			throw new Error("Expected streaming assistant component");
		}

		await controller.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "thinking_delta",
				delta: "server-side reasoning",
				contentIndex: 0,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);

		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("server-side reasoning");
	});
});

describe("EventController working loader reconciliation", () => {
	it("restores the working loader after compaction clears status while the focused session streams", async () => {
		const { controller, ctx } = createFixture();
		const loader = { stop: vi.fn() } as unknown as InteractiveModeContext["autoCompactionLoader"];
		ctx.autoCompactionLoader = loader;
		(ctx.viewSession as unknown as { isStreaming: boolean }).isStreaming = true;

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: true,
		} as Extract<AgentSessionEvent, { type: "auto_compaction_end" }>);

		expect(loader?.stop).toHaveBeenCalledTimes(1);
		expect(ctx.statusContainer.disposeChildren).toHaveBeenCalledTimes(1);
		expect(ctx.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
		expect(ctx.ensureLoadingAnimation).toHaveBeenCalledTimes(1);
	});

	it("self-heals missing working loader on live tool updates", async () => {
		const { controller, ctx } = createFixture();
		(ctx.viewSession as unknown as { isStreaming: boolean }).isStreaming = true;

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "missing",
			partialResult: {},
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);

		expect(ctx.ensureLoadingAnimation).toHaveBeenCalledTimes(1);
	});

	it("self-heals missing working loader when a task subagent finishes mid-turn (#3858)", async () => {
		// `task` subagents run inside the parent's streaming turn. While the task is
		// running a transient overlay (auto-compaction / auto-retry) can drop the
		// working loader by clearing the status container, and the overlay's end
		// handler is the only restorer keyed off the missing loader. If the task
		// finishes between the overlay's start and end (or any other branch where
		// the loader was nulled without a follow-up overlay-end), `tool_execution_end`
		// is the next streaming event that lands and must heal the loader, mirroring
		// the `tool_execution_update` reconciler. Without this the spinner stays
		// gone for the remainder of the parent turn even though the agent keeps
		// streaming (the user-visible regression in #3858).
		const { controller, ctx } = createFixture();
		(ctx.viewSession as unknown as { isStreaming: boolean }).isStreaming = true;

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "task-1",
			toolName: "task",
			isError: false,
			result: { content: [{ type: "text", text: "ok" }], details: {} },
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(ctx.ensureLoadingAnimation).toHaveBeenCalledTimes(1);
	});

	it("does not restore the working loader while an overlay loader (auto-retry) owns the status container at tool_execution_end", async () => {
		const { controller, ctx } = createFixture();
		ctx.retryLoader = { stop: vi.fn() } as unknown as InteractiveModeContext["retryLoader"];
		(ctx.viewSession as unknown as { isStreaming: boolean }).isStreaming = true;

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "task-2",
			toolName: "task",
			isError: false,
			result: { content: [{ type: "text", text: "ok" }], details: {} },
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(ctx.ensureLoadingAnimation).not.toHaveBeenCalled();
	});

	it("keeps transient retry status exclusive while a retry loader is visible", async () => {
		const { controller, ctx } = createFixture();
		ctx.retryLoader = { stop: vi.fn() } as unknown as InteractiveModeContext["retryLoader"];
		(ctx.viewSession as unknown as { isStreaming: boolean }).isStreaming = true;

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "missing",
			partialResult: {},
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);

		expect(ctx.ensureLoadingAnimation).not.toHaveBeenCalled();
	});
});

describe("ErrorBannerComponent", () => {
	it("renders the provider error message", () => {
		const banner = new ErrorBannerComponent("Output blocked by content filtering policy");
		const rendered = Bun.stripANSI(banner.render(120).join("\n"));
		expect(rendered).toContain("Output blocked by content filtering policy");
		expect(rendered).toContain("Dismissed when you send your next message.");
	});

	it("caps an oversized multi-line error to a few lines", () => {
		const huge = Array.from({ length: 50 }, (_, i) => `error detail line ${i}`).join("\n");
		const banner = new ErrorBannerComponent(huge);
		const lines = Bun.stripANSI(banner.render(120).join("\n")).split("\n");
		const detailLines = lines.filter(line => line.includes("error detail line"));
		expect(detailLines.length).toBeLessThanOrEqual(3);
		expect(detailLines.length).toBeGreaterThan(0);
	});
});

describe("AssistantMessageComponent error pinning", () => {
	it("hides the inline error while pinned and restores it afterwards", () => {
		const message = makeAssistantMessage({
			content: [],
			stopReason: "error",
			errorMessage: "400 invalid reasoning value",
		});
		const component = new AssistantMessageComponent(message);

		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("Error: 400 invalid reasoning value");

		component.setErrorPinned(true);
		expect(Bun.stripANSI(component.render(120).join("\n"))).not.toContain("Error: 400 invalid reasoning value");

		component.setErrorPinned(false);
		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("Error: 400 invalid reasoning value");
	});
});
