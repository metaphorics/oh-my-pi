/**
 * LLM assembly cost on a long AgentMessage[] history.
 *
 * Measures:
 *  (a) convertToLlm on a growing history: 10 successive calls, append-2 between
 *      each call. Reports first-call and steady-state (mean of last 3) so WS-E
 *      can show ≥10× improvement on steady-state.
 *  (b) estimateTokens sweep — cold first/second on fresh message identities
 *      before any multi-sweep warmup on shared identities.
 *
 * Acceptance after WS-E: steady-state repeat convert ≥10× faster than first call;
 * second estimateTokens sweep ≥10× first.
 *
 *   bun run packages/coding-agent/bench/llm-assembly.bench.ts
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { estimateTokens } from "@oh-my-pi/pi-agent-core";
import { convertToLlm } from "../src/session/messages";
import { buildSyntheticAgentMessages } from "./fixtures/synthetic-transcript";

const N = 5000;
const CALLS_PER_EPISODE = 10;
const APPEND_PER_CALL = 2;
const WARMUP_EPISODES = 8;
const MEASURE_EPISODES = 40;
const SWEEPS_PER_SAMPLE = 8;
const WARMUP_SWEEP_SAMPLES = 4;
const MEASURE_SWEEP_SAMPLES = 24;

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
	// Benches intentionally emit metrics on stdout (canonical streaming-throughput style).
	console.log(JSON.stringify({ metric, median_ms, stddev_ms }));
	console.log(`METRIC ${metric}=${median_ms.toFixed(4)}`);
}

function makePadMessage(i: number): AgentMessage {
	return {
		role: "user",
		content: `append-turn pad #${i}: please continue analysis with extra context padding ${"z".repeat(200)}`,
		timestamp: 1_000_000 + i,
	};
}

/**
 * One successive episode on a growing history:
 * start from a FRESH base (new message identities each episode so post-WS-E
 * identity memo cannot poison first-call measurements), each of 10 calls runs
 * convertToLlm then appends 2. Returns per-call timings.
 */
function runSuccessiveEpisode(freshBase: AgentMessage[]): number[] {
	const history = freshBase.slice();
	let pad = 0;
	const times: number[] = [];
	for (let call = 0; call < CALLS_PER_EPISODE; call++) {
		const t0 = performance.now();
		void convertToLlm(history);
		times.push(performance.now() - t0);
		for (let a = 0; a < APPEND_PER_CALL; a++) {
			history.push(makePadMessage(pad++));
		}
	}
	return times;
}

console.log(`llm-assembly: building N=${N} AgentMessage[] fixture…`);
const templateMessages = buildSyntheticAgentMessages(N);
console.log(`  fixture length=${templateMessages.length}`);

/** Fresh object identities each episode (WeakMap-safe) without rebuild cost noise. */
function freshHistoryFromTemplate(): AgentMessage[] {
	return templateMessages.map(m => {
		if (m && typeof m === "object") {
			return { ...(m as object) } as AgentMessage;
		}
		return m;
	});
}

// ── (a) convertToLlm successive growing history ─────────────────────────────
// Fresh AgentMessage identities per episode so WS-E memo cannot warm "first"
// across samples. Template is cloned shallowly (new object identity, shared
// nested content) to avoid N=5000 rebuild noise dominating stddev.
for (let i = 0; i < WARMUP_EPISODES; i++) {
	runSuccessiveEpisode(freshHistoryFromTemplate());
}

const convertEpisodeSamples: number[] = [];
const firstCallSamples: number[] = [];
const steadyCallSamples: number[] = [];

for (let i = 0; i < MEASURE_EPISODES; i++) {
	if (i % 8 === 0) Bun.gc(true);
	const times = runSuccessiveEpisode(freshHistoryFromTemplate());
	convertEpisodeSamples.push(times.reduce((a, b) => a + b, 0));
	firstCallSamples.push(times[0] ?? 0);
	const last3 = times.slice(-3);
	steadyCallSamples.push(last3.reduce((a, b) => a + b, 0) / Math.max(last3.length, 1));
}

const convertMedian = median(convertEpisodeSamples);
const convertSd = stddev(convertEpisodeSamples);
const firstMedian = median(firstCallSamples);
const steadyMedian = median(steadyCallSamples);

console.log(
	`  convertToLlm ${MEASURE_EPISODES} episodes × ${CALLS_PER_EPISODE} successive growing calls: ` +
		`median=${convertMedian.toFixed(4)}ms/episode stddev=${convertSd.toFixed(4)}ms ` +
		`(~${(convertMedian / CALLS_PER_EPISODE).toFixed(4)}ms/call)`,
);
console.log(
	`  convert first-call median=${firstMedian.toFixed(4)}ms ` +
		`steady(last3) median=${steadyMedian.toFixed(4)}ms ` +
		`speedup=${firstMedian > 0 ? (firstMedian / Math.max(steadyMedian, 1e-9)).toFixed(2) : "n/a"}× ` +
		`(post WS-E target ≥10×)`,
);
emitMetric("llm_assembly_convert_ms", convertMedian, convertSd);
emitMetric("llm_assembly_convert_first_ms", firstMedian, stddev(firstCallSamples));
emitMetric("llm_assembly_convert_steady_ms", steadyMedian, stddev(steadyCallSamples));

// ── (b) estimateTokens sweep ────────────────────────────────────────────────
function sweepTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const m of messages) total += estimateTokens(m);
	return total;
}

function multiSweepMs(messages: AgentMessage[], sweeps: number): { ms: number; total: number } {
	let total = 0;
	const t0 = performance.now();
	for (let s = 0; s < sweeps; s++) total = sweepTokens(messages);
	return { ms: (performance.now() - t0) / sweeps, total };
}

// Cold first/second on FRESH identities BEFORE any multi-sweep warmup.
// Pre-WS-E both may be similar; post-WS-E first >> second when memoized by identity.
const coldMessages = buildSyntheticAgentMessages(N);
const firstSweepT0 = performance.now();
const coldTotal = sweepTokens(coldMessages);
const firstSweep = performance.now() - firstSweepT0;
const secondSweepT0 = performance.now();
sweepTokens(coldMessages);
const secondSweep = performance.now() - secondSweepT0;

console.log(
	`  estimateTokens cold first=${firstSweep.toFixed(4)}ms second=${secondSweep.toFixed(4)}ms ` +
		`speedup=${firstSweep > 0 ? (firstSweep / Math.max(secondSweep, 1e-9)).toFixed(2) : "n/a"}× ` +
		`totalTokens≈${coldTotal} (measured before warm multi-sweeps)`,
);

// Steady multi-sweep samples on a dedicated warm fixture (after cold capture).
const warmMessages = buildSyntheticAgentMessages(N);
for (let i = 0; i < WARMUP_SWEEP_SAMPLES; i++) multiSweepMs(warmMessages, SWEEPS_PER_SAMPLE);

const sweepSamples: number[] = [];
let lastTotal = 0;
for (let i = 0; i < MEASURE_SWEEP_SAMPLES; i++) {
	const r = multiSweepMs(warmMessages, SWEEPS_PER_SAMPLE);
	sweepSamples.push(r.ms);
	lastTotal = r.total;
}

const sweepMedian = median(sweepSamples);
const sweepSd = stddev(sweepSamples);

console.log(
	`  estimateTokens sweep: median=${sweepMedian.toFixed(4)}ms stddev=${sweepSd.toFixed(4)}ms ` +
		`totalTokens≈${lastTotal}`,
);
emitMetric("llm_assembly_estimate_tokens_ms", sweepMedian, sweepSd);
emitMetric("llm_assembly_estimate_tokens_first_ms", firstSweep, 0);
emitMetric("llm_assembly_estimate_tokens_second_ms", secondSweep, 0);

const convertNoise = convertMedian > 0 ? convertSd / convertMedian : 0;
const sweepNoise = sweepMedian > 0 ? sweepSd / sweepMedian : 0;
if (convertNoise > 0.2) {
	console.warn(`  warning: convert noise ${(convertNoise * 100).toFixed(1)}% > 20%`);
}
if (sweepNoise > 0.2) {
	console.warn(`  warning: estimateTokens noise ${(sweepNoise * 100).toFixed(1)}% > 20%`);
}
