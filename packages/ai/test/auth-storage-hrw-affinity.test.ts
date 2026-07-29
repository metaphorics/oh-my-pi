import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredentialStore,
	AuthStorage,
	rendezvousScore,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const HOUR_MS = 60 * 60 * 1000;

/**
 * HRW winner among string-keyed candidates — same descending-score order the
 * comparator uses.
 */
function hrwWinner(sessionKey: string, candidates: readonly string[]): string {
	return [...candidates]
		.map(c => ({ c, score: rendezvousScore(sessionKey, c) }))
		.sort((a, b) => (b.score > a.score ? 1 : b.score < a.score ? -1 : 0))[0].c;
}

// ─── Pure function tests on rendezvousScore ───────────────────────────────

describe("rendezvousScore", () => {
	test("is deterministic for a given session/candidate pair", () => {
		const first = rendezvousScore("session-1", "candidate-a");
		const second = rendezvousScore("session-1", "candidate-a");

		expect(first).toBe(second);
		expect(typeof first).toBe("bigint");
	});

	test("produces a stable total order per session across distinct candidates", () => {
		const session = "session-stable-order";
		const candidates = ["alpha", "bravo", "charlie", "delta", "echo"];

		const order = [...candidates]
			.map(c => ({ c, score: rendezvousScore(session, c) }))
			.sort((a, b) => (b.score > a.score ? 1 : b.score < a.score ? -1 : 0))
			.map(entry => entry.c);

		const replay = [...candidates]
			.map(c => ({ c, score: rendezvousScore(session, c) }))
			.sort((a, b) => (b.score > a.score ? 1 : b.score < a.score ? -1 : 0))
			.map(entry => entry.c);

		expect(order).toEqual(replay);
		expect([...order].sort()).toEqual([...candidates].sort());
	});

	test("distributes distinct sessions across distinct winners", () => {
		const candidates = ["alpha", "bravo", "charlie", "delta"];
		const sessions = Array.from({ length: 20 }, (_, index) => `session-${index}`);

		const winners = new Set(sessions.map(session => hrwWinner(session, candidates)));
		expect(winners.size).toBeGreaterThan(1);
	});
});

// ─── Minimal-disruption golden test ───────────────────────────────────────

describe("rendezvousScore minimal disruption", () => {
	const sessions = ["sess-1", "sess-2", "sess-3", "sess-4", "sess-5", "sess-6"];

	test("adding a candidate moves only sessions that rendezvous-map to it", () => {
		const before = ["alpha", "bravo", "charlie"];
		const after = ["alpha", "bravo", "charlie", "delta"];

		const movers: string[] = [];
		for (const session of sessions) {
			const oldWinner = hrwWinner(session, before);
			const newWinner = hrwWinner(session, after);
			if (oldWinner !== newWinner) {
				movers.push(session);
				expect(newWinner).toBe("delta");
			}
		}
		// At least one session should adopt the new candidate — otherwise delta
		// would be a dead letter, defeating the purpose of HRW.
		expect(movers.length).toBeGreaterThan(0);
	});

	test("removing a candidate moves only sessions that were mapped to it", () => {
		const before = ["alpha", "bravo", "charlie", "delta"];
		const after = ["alpha", "bravo", "charlie"];

		for (const session of sessions) {
			const oldWinner = hrwWinner(session, before);
			const newWinner = hrwWinner(session, after);
			if (oldWinner !== newWinner) {
				// Only sessions whose old winner was the removed candidate move.
				expect(oldWinner).toBe("delta");
			}
		}
	});
});

// ─── Ranker integration tests ─────────────────────────────────────────────

describe("AuthStorage HRW credential affinity", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const usageByKey = new Map<string, UsageReport>();

	const usageProvider: UsageProvider = {
		id: "zai",
		async fetchUsage(params) {
			const apiKey = params.credential.apiKey;
			if (!apiKey) return null;
			return usageByKey.get(apiKey) ?? null;
		},
		supports: params => params.provider === "zai" && params.credential.type === "api_key",
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-hrw-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "zai" ? usageProvider : undefined),
		});
		usageByKey.clear();
	});

	afterEach(async () => {
		authStorage?.close();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
		}
		tempDir = "";
	});

	test("selects the same credential for a given session across repeated calls", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("zai", [
			{ type: "api_key", key: "key-a", source: "login" },
			{ type: "api_key", key: "key-b", source: "login" },
			{ type: "api_key", key: "key-c", source: "login" },
		]);

		const keys: string[] = [];
		for (let i = 0; i < 5; i++) {
			const key = await authStorage.getApiKey("zai", "stable-session");
			if (key) keys.push(key);
		}

		// HRW must be deterministic: same session → same credential every call.
		expect(new Set(keys).size).toBe(1);
	});

	test("distributes distinct sessions across multiple credentials", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("zai", [
			{ type: "api_key", key: "key-a", source: "login" },
			{ type: "api_key", key: "key-b", source: "login" },
			{ type: "api_key", key: "key-c", source: "login" },
		]);

		const selected = new Set<string>();
		for (let i = 0; i < 30; i++) {
			const key = await authStorage.getApiKey("zai", `session-${i}`);
			if (key) selected.add(key);
		}

		expect(selected.size).toBeGreaterThan(1);
	});

	test("round-robins without sessionId — HRW is an exact no-op", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("zai", [
			{ type: "api_key", key: "key-a", source: "login" },
			{ type: "api_key", key: "key-b", source: "login" },
			{ type: "api_key", key: "key-c", source: "login" },
		]);

		const keys: string[] = [];
		for (let i = 0; i < 6; i++) {
			const key = await authStorage.getApiKey("zai");
			if (key) keys.push(key);
		}

		// Without sessionId the comparator falls back to orderPos (round-robin),
		// so successive calls must rotate through distinct credentials.
		expect(new Set(keys).size).toBeGreaterThan(1);
	});

	test("never reorders across differing rank tiers", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;

		await storage.set("zai", [
			{ type: "api_key", key: "key-exhausted", source: "login" },
			{ type: "api_key", key: "key-fresh", source: "login" },
		]);

		usageByKey.set("key-exhausted", {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: {
						id: "5h",
						label: "5 Hour",
						durationMs: 5 * HOUR_MS,
						resetsAt: Date.now() + HOUR_MS,
					},
					amount: {
						unit: "requests",
						used: 100,
						limit: 100,
						remaining: 0,
						usedFraction: 1,
						remainingFraction: 0,
					},
					status: "exhausted",
				},
			],
		});
		usageByKey.set("key-fresh", {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: {
						id: "5h",
						label: "5 Hour",
						durationMs: 5 * HOUR_MS,
						resetsAt: Date.now() + 2 * HOUR_MS,
					},
					amount: {
						unit: "requests",
						used: 20,
						limit: 100,
						remaining: 80,
						usedFraction: 0.2,
						remainingFraction: 0.8,
					},
					status: "ok",
				},
			],
		});

		// Across many sessions, the fresh key must always win — HRW never
		// overrides the usage-priority ordering.
		for (let i = 0; i < 20; i++) {
			const key = await storage.getApiKey("zai", `tier-test-${i}`);
			expect(key).toBe("key-fresh");
		}
	});
});
