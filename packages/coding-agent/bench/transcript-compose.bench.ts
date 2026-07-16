/**
 * Transcript compose cost vs history length N.
 *
 * Mounts synthetic components in a TranscriptContainer, finalizes all but the
 * last, simulates native scrollback commit after the first paint, then measures
 * container.render(width) while mutating only the tail assistant each episode.
 *
 * Baseline (pre WS-C seal) is expected to show O(n) growth.
 * Acceptance after WS-C: ratio(N5000/N500) ≤ 1.3 and N=5000 median <10ms.
 *
 *   bun run packages/coding-agent/bench/transcript-compose.bench.ts
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "../src/config/settings";
import { AssistantMessageComponent } from "../src/modes/components/assistant-message";
import { TranscriptContainer } from "../src/modes/components/transcript-container";
import { initTheme } from "../src/modes/theme/theme";
import { buildSyntheticComponents } from "./fixtures/synthetic-transcript";

const WIDTH = 100;
const VIEWPORT_ROWS = 24;
const WARMUP_EPISODES = 16;
const MEASURE_EPISODES = 80;
/** Pure renders per sample (mutate outside timer) to lift above timer noise floor. */
const RENDERS_PER_SAMPLE = 256;

function median(xs: number[]): number {
	if (xs.length === 0) return 0;
	const sorted = [...xs].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	if (sorted.length % 2 === 1) {
		return sorted[mid] ?? 0;
	}
	const lo = sorted[mid - 1] ?? 0;
	const hi = sorted[mid] ?? 0;
	return (lo + hi) / 2;
}

/** Sample standard deviation (n-1); 0 for <2 samples. */
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

function makeTailMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "bench",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function measureCompose(n: number): { median_ms: number; stddev_ms: number; samples: number[] } {
	const { components, lastAssistant } = buildSyntheticComponents(n, { mutableTail: true });
	if (!lastAssistant) {
		throw new Error("transcript-compose: expected mutable lastAssistant from fixture");
	}
	const last = components[components.length - 1];
	if (last !== lastAssistant || lastAssistant.isTranscriptBlockFinalized()) {
		throw new Error(
			`transcript-compose: lastAssistant must be last unfinalized child ` +
				`(last===lastAssistant=${last === lastAssistant}, finalized=${lastAssistant.isTranscriptBlockFinalized()}, n=${n})`,
		);
	}
	const container = new TranscriptContainer();
	for (const c of components) container.addChild(c);

	// First paint + scrollback commit simulation (history above viewport is committed).
	const first = container.render(WIDTH);
	const committed = Math.max(0, first.length - VIEWPORT_ROWS);
	container.setNativeScrollbackCommittedRows(committed);

	const tailBase =
		"## Live tail\n\nStreaming update for compose bench.\n\n```ts\nconst frame = " +
		"performance.now();\n```\n\n";

	for (let i = 0; i < WARMUP_EPISODES; i++) {
		// Mutate outside the timed window — only container.render is measured.
		lastAssistant.updateContent(makeTailMessage(`${tailBase}warmup=${i}\n`));
		container.render(WIDTH);
	}

	const samples: number[] = [];
	for (let i = 0; i < MEASURE_EPISODES; i++) {
		// Mutate outside every sub-timer so U (updateContent) cannot dilute ratio(N).
		// RENDERS_PER_SAMPLE pure timed renders; re-dirty before each so caches cannot false-pass.
		let total = 0;
		for (let r = 0; r < RENDERS_PER_SAMPLE; r++) {
			lastAssistant.updateContent(
				makeTailMessage(`${tailBase}episode=${i}\nsub=${r}\npad=${"y".repeat((i + r) % 17)}\n`),
			);
			const t0 = performance.now();
			container.render(WIDTH);
			total += performance.now() - t0;
		}
		samples.push(total / RENDERS_PER_SAMPLE);
	}

	return { median_ms: median(samples), stddev_ms: stddev(samples), samples };
}

function emitMetric(metric: string, median_ms: number, stddev_ms: number): void {
	const line = JSON.stringify({ metric, median_ms, stddev_ms });
	// Benches intentionally emit metrics on stdout (canonical streaming-throughput style).
	console.log(line);
	console.log(`METRIC ${metric}=${median_ms.toFixed(4)}`);
}

await Settings.init({ inMemory: true });
await initTheme("dark");

const sizes = [500, 5000] as const;
const results: Record<string, { median_ms: number; stddev_ms: number }> = {};

for (const n of sizes) {
	const metric = n === 500 ? "transcript_compose_n500_ms" : "transcript_compose_n5000_ms";
	console.log(`transcript-compose: measuring N=${n} (warmup=${WARMUP_EPISODES}, measure=${MEASURE_EPISODES})…`);
	const r = measureCompose(n);
	const noise = r.median_ms > 0 ? r.stddev_ms / r.median_ms : 0;
	console.log(
		`  N=${n}: median=${r.median_ms.toFixed(4)}ms stddev=${r.stddev_ms.toFixed(4)}ms ` +
			`noise=${(noise * 100).toFixed(1)}%`,
	);
	if (noise > 0.2) {
		console.warn(
			`  warning: stddev/median ${(noise * 100).toFixed(1)}% > 20% — consider widening MEASURE_EPISODES`,
		);
	}
	emitMetric(metric, r.median_ms, r.stddev_ms);
	results[metric] = { median_ms: r.median_ms, stddev_ms: r.stddev_ms };
}

const n500 = results.transcript_compose_n500_ms?.median_ms ?? 0;
const n5000 = results.transcript_compose_n5000_ms?.median_ms ?? 0;
const ratio = n500 > 0 ? n5000 / n500 : 0;
console.log(`ratio(N5000/N500)=${ratio.toFixed(3)} (baseline pre-seal; post WS-C target ≤1.3)`);
console.log(`METRIC transcript_compose_ratio=${ratio.toFixed(4)}`);
console.log(
	JSON.stringify({
		metric: "transcript_compose_ratio",
		median_ms: ratio,
		stddev_ms: 0,
	}),
);
