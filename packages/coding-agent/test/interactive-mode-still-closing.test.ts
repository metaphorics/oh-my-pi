/**
 * Workstream D: InteractiveMode.shutdown arms a 3s "Still closing…" status
 * before signal teardown and always clears the timer in finally.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("InteractiveMode.shutdown still-closing status (WS-D)", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-still-closing-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
		// Avoid real terminal drain during unit test.
		mode.ui.terminal.drainInput = async () => {};
		vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		vi.useRealTimers();
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("shows Still closing… after 3s while teardown is still pending, then clears timer", async () => {
		vi.useFakeTimers();
		const statuses: string[] = [];
		vi.spyOn(mode, "showStatus").mockImplementation((message: string) => {
			statuses.push(message);
		});

		const teardownGate = Promise.withResolvers<void>();
		// Force the fallback dispose path (no #signalTeardown) so we control settle.
		vi.spyOn(session, "dispose").mockImplementation(async () => {
			await teardownGate.promise;
		});

		const shutdownPromise = mode.shutdown();
		await flushMicrotasks();
		expect(statuses).toEqual(["Closing session…"]);

		vi.advanceTimersByTime(2_999);
		await flushMicrotasks();
		expect(statuses).toEqual(["Closing session…"]);

		vi.advanceTimersByTime(1);
		await flushMicrotasks();
		expect(statuses).toEqual([
			"Closing session…",
			"Still closing… (flushing memory backend / network)",
		]);

		teardownGate.resolve();
		await shutdownPromise;

		// Timer must be cleared: advancing further must not re-fire status.
		const after = statuses.length;
		vi.advanceTimersByTime(10_000);
		await flushMicrotasks();
		expect(statuses.length).toBe(after);
	});

	it("clears the still-closing timer when teardown finishes under 3s", async () => {
		vi.useFakeTimers();
		const statuses: string[] = [];
		vi.spyOn(mode, "showStatus").mockImplementation((message: string) => {
			statuses.push(message);
		});
		vi.spyOn(session, "dispose").mockResolvedValue(undefined);

		await mode.shutdown();
		expect(statuses).toEqual(["Closing session…"]);

		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		expect(statuses).toEqual(["Closing session…"]);
	});
});
