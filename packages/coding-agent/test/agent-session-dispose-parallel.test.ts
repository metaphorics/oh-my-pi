/**
 * Workstream D: parallelize session dispose so /exit no longer stacks subsystem
 * timeouts. Contracts:
 *  - independent Phase-B branches start before either resolves (causal, not wall-only)
 *  - post-prompt drain is bounded at 5s with the exact warn string
 *  - async-job delivery write lands before sessionManager.close
 *  - idle dispose stays under the 3s perceived-hang budget
 *  - owned AsyncJobManager singleton clears even when dispose rejects
 *  - mnemopi embed shutdown runs even when state.dispose rejects
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import * as mnemopiEmbedClientModule from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import {
	type MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

type Deferred = {
	promise: Promise<void>;
	resolve: () => void;
};

function deferred(): Deferred {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

function hindsightFlushStub(flush: () => Promise<void>): HindsightSessionState {
	const stub = {
		flushRetainQueue: flush,
		dispose: () => {},
	};
	return stub as HindsightSessionState;
}

describe("AgentSession dispose parallelization (WS-D)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-dispose-parallel-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		const current = session;
		session = undefined;
		if (current) {
			await current.dispose();
		}
		authStorage?.close();
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
		tempDir?.removeSync();
	});

	async function createSession(options?: {
		ownedAsyncJobManager?: AsyncJobManager;
		persist?: boolean;
	}): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled anthropic model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			streamFn: mock.stream,
		});
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const sessionManager = options?.persist
			? SessionManager.create(tempDir.path(), tempDir.path())
			: SessionManager.inMemory(tempDir.path());
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			ownedAsyncJobManager: options?.ownedAsyncJobManager,
			agentId: "Main",
		});
		return session;
	}

	it("starts independent Phase-B branches before either resolves", async () => {
		const asyncStarted = deferred();
		const hindsightStarted = deferred();
		const asyncGate = deferred();
		const hindsightGate = deferred();
		const order: string[] = [];

		const owned = {
			dispose: async (_opts?: { timeoutMs?: number }) => {
				order.push("async:start");
				asyncStarted.resolve();
				await asyncGate.promise;
				order.push("async:end");
				return true;
			},
			// #cancelOwnAsyncJobs calls cancelAll on the scoped manager before dispose.
			cancelAll: () => {},
			getDeliveryState: () => ({
				queued: 0,
				delivering: false,
				pendingJobIds: [] as string[],
			}),
		} as AsyncJobManager;

		const s = await createSession({ ownedAsyncJobManager: owned });
		s.setHindsightSessionState(
			hindsightFlushStub(async () => {
				order.push("hindsight:start");
				hindsightStarted.resolve();
				await hindsightGate.promise;
				order.push("hindsight:end");
			}),
		);

		const disposePromise = s.dispose();
		try {
			// Causal barrier: both branches must have entered before either finishes.
			// Start order between branches is not fixed — only that both start first.
			await Promise.all([asyncStarted.promise, hindsightStarted.promise]);
			expect(order).toContain("async:start");
			expect(order).toContain("hindsight:start");
			expect(order).not.toContain("async:end");
			expect(order).not.toContain("hindsight:end");
		} finally {
			asyncGate.resolve();
			hindsightGate.resolve();
		}
		await disposePromise;
		session = undefined;

		const asyncStartAt = order.indexOf("async:start");
		const hindsightStartAt = order.indexOf("hindsight:start");
		const firstEnd = Math.min(order.indexOf("async:end"), order.indexOf("hindsight:end"));
		expect(asyncStartAt).toBeGreaterThanOrEqual(0);
		expect(hindsightStartAt).toBeGreaterThanOrEqual(0);
		expect(asyncStartAt).toBeLessThan(firstEnd);
		expect(hindsightStartAt).toBeLessThan(firstEnd);
	});

	it(
		"bounds a never-settling post-prompt task at 5s and logs the exact warn",
		async () => {
			// Real platform clock: withTimeout is implemented with setTimeout, and
			// awaiting dispose under fake timers leaves the deadline timer unfired
			// while the hang task never settles. This is the intentional 5s hang-fix.
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const hang = deferred(); // intentionally never resolved

			const s = await createSession();
			s.trackPostPromptTaskForTests(hang.promise);
			expect(s.hasPostPromptWork).toBe(true);

			const started = performance.now();
			await s.dispose();
			session = undefined;
			const elapsed = performance.now() - started;

			expect(elapsed).toBeGreaterThanOrEqual(4_500);
			expect(elapsed).toBeLessThan(7_000);
			expect(
				warnSpy.mock.calls.some(call => call[0] === "Post-prompt tasks still draining at dispose deadline"),
			).toBe(true);
		},
		15_000,
	);

	it("writes async-job delivery entries before sessionManager.close", async () => {
		const order: string[] = [];
		const deliveryGate = deferred();
		const deliveryEntered = deferred();

		const asyncJobManager = new AsyncJobManager({
			maxRunningJobs: 2,
			retentionMs: 1_000,
			onJobComplete: async (jobId, text) => {
				deliveryEntered.resolve();
				await deliveryGate.promise;
				const manager = session?.sessionManager;
				if (!manager) throw new Error("session missing during delivery");
				manager.appendCustomMessageEntry(
					"async-result",
					`delivery:${jobId}:${text}`,
					true,
					{ jobId },
					"agent",
				);
				order.push("delivery-write");
			},
		});
		AsyncJobManager.setInstance(asyncJobManager);

		const s = await createSession({ ownedAsyncJobManager: asyncJobManager, persist: true });
		const sessionFile = s.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");

		const originalClose = s.sessionManager.close.bind(s.sessionManager);
		s.sessionManager.close = async () => {
			order.push("close");
			await originalClose();
		};

		asyncJobManager.register("bash", "writer job", async () => "payload", {
			id: "writer-job",
			ownerId: "Main",
		});

		// Await the real delivery-entry signal rather than a guessed sleep.
		await deliveryEntered.promise;

		const disposePromise = s.dispose();
		// Release delivery after dispose has started so drain must complete first.
		deliveryGate.resolve();
		await disposePromise;
		session = undefined;

		expect(order[0]).toBe("delivery-write");
		expect(order).toContain("close");
		const writeAt = order.indexOf("delivery-write");
		const closeAt = order.indexOf("close");
		expect(writeAt).toBeGreaterThanOrEqual(0);
		expect(closeAt).toBeGreaterThan(writeAt);

		// Prefer in-memory entries (always available post-close); fall back to
		// the on-disk JSONL when the file still exists after close.
		const entries = s.sessionManager.getEntries();
		const hasDelivery = entries.some(entry => {
			if (entry.type !== "custom_message") return false;
			const content = entry.content;
			const text = typeof content === "string" ? content : JSON.stringify(content);
			return text.includes("delivery:writer-job:payload");
		});
		if (!hasDelivery && fs.existsSync(sessionFile)) {
			const body = fs.readFileSync(sessionFile, "utf8");
			expect(body).toContain("delivery:writer-job:payload");
		} else {
			expect(hasDelivery).toBe(true);
		}
	});

	it("idle dispose completes under the 3s status budget", async () => {
		// Integration wall-clock check against the real platform clock: the
		// perceived-hang status arms at 3s, and empty/idle dispose must finish
		// under that without a pending network flush. Fake timers would not
		// exercise the real subsystem teardown path.
		const s = await createSession();
		const started = performance.now();
		await s.dispose();
		session = undefined;
		const elapsed = performance.now() - started;
		expect(elapsed).toBeLessThan(3_000);
	});

	it("clears owned AsyncJobManager singleton when dispose rejects", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const owned = {
			dispose: async (_opts?: { timeoutMs?: number }) => {
				throw new Error("owned async dispose boom");
			},
			// #cancelOwnAsyncJobs calls cancelAll on the scoped manager before dispose.
			cancelAll: () => {},
			getDeliveryState: () => ({
				queued: 0,
				delivering: false,
				pendingJobIds: [] as string[],
			}),
		} as AsyncJobManager;
		AsyncJobManager.setInstance(owned);

		const s = await createSession({ ownedAsyncJobManager: owned });
		await s.dispose();
		session = undefined;

		expect(AsyncJobManager.instance()).toBeUndefined();
		expect(
			warnSpy.mock.calls.some(
				call =>
					call[0] === "Session dispose subsystem failed during parallel teardown" &&
					String((call[1] as { error?: unknown } | undefined)?.error ?? "").includes(
						"owned async dispose boom",
					),
			),
		).toBe(true);
	});

	it("shuts down mnemopi embed client when state.dispose rejects", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		// Runtime method resolution through the module-level singleton — not the
		// static named import of shutdownMnemopiEmbedClient — so the spy is observed.
		const terminateSpy = vi
			.spyOn(mnemopiEmbedClientModule.mnemopiEmbedClient, "terminate")
			.mockResolvedValue(undefined);

		const order: string[] = [];
		const rejectingState = {
			dispose: async (_opts?: { timeoutMs?: number; consolidate?: boolean }) => {
				order.push("mnemopi:dispose");
				throw new Error("mnemopi dispose boom");
			},
		} as MnemopiSessionState;

		const s = await createSession();
		setMnemopiSessionState(s, rejectingState);
		await s.dispose();
		session = undefined;

		order.push("after-dispose");
		expect(order).toEqual(["mnemopi:dispose", "after-dispose"]);
		expect(terminateSpy).toHaveBeenCalled();
		expect(
			warnSpy.mock.calls.some(
				call =>
					call[0] === "Session dispose subsystem failed during parallel teardown" &&
					String((call[1] as { error?: unknown } | undefined)?.error ?? "").includes("mnemopi dispose boom"),
			),
		).toBe(true);
	});
});
