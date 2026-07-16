/**
 * Idle AgentSession.dispose wall-clock (Workstream D).
 *
 * Measures empty/idle dispose with no pending network flush. Acceptance:
 * median < 3000ms (the InteractiveMode "Still closing…" status budget).
 *
 *   bun run packages/coding-agent/bench/session-dispose.bench.ts
 */
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const WARMUP = 4;
const MEASURE = 24;

function median(xs: number[]): number {
	if (xs.length === 0) return 0;
	const sorted = [...xs].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
	return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function stddev(xs: number[]): number {
	if (xs.length < 2) return 0;
	const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
	let sumSq = 0;
	for (const x of xs) {
		const d = x - mean;
		sumSq += d * d;
	}
	return Math.sqrt(sumSq / (xs.length - 1));
}

function emitMetric(metric: string, median_ms: number, stddev_ms: number): void {
	console.log(JSON.stringify({ metric, median_ms, stddev_ms }));
	console.log(`METRIC ${metric}=${median_ms.toFixed(4)}`);
}

async function measureOnce(tempDir: TempDir, authStorage: AuthStorage): Promise<number> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("expected bundled anthropic model");
	const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["bench"], tools: [] },
		streamFn: mock.stream,
	});
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings: Settings.isolated(),
		modelRegistry,
	});
	const t0 = performance.now();
	await session.dispose();
	return performance.now() - t0;
}

async function main(): Promise<void> {
	using tempDir = TempDir.createSync("@omp-dispose-bench-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");

	for (let i = 0; i < WARMUP; i++) {
		await measureOnce(tempDir, authStorage);
	}

	const samples: number[] = [];
	for (let i = 0; i < MEASURE; i++) {
		samples.push(await measureOnce(tempDir, authStorage));
	}

	authStorage.close();
	const med = median(samples);
	const sd = stddev(samples);
	emitMetric("session.dispose.idle_ms", med, sd);
	if (med >= 3_000) {
		console.error(`FAIL: idle dispose median ${med.toFixed(2)}ms >= 3000ms status budget`);
		process.exitCode = 1;
	}
}

await main();
