/**
 * Keystroke → render-complete frame cost with a session-scale transcript sibling.
 *
 * Mounts a CountingLines stand-in (15k cached rows) + Editor under a TUI driven
 * by VirtualTerminal + StressRenderScheduler. Each keystroke is one printable
 * char with editor reset outside the timed window (empty editor every press).
 * An episode averages KEYS_PER_EPISODE independent one-key latencies so the
 * sample window is long enough for stable median±stddev across episodes.
 *
 * Records:
 *  - keystroke frame median_ms / stddev_ms (one keypress → render-complete)
 *  - transcript stand-in render() calls per keystroke (target 0 after WS-B)
 *
 * Acceptance after WS-B: transcript renders/keystroke == 0 and median <5ms.
 *
 *   bun run packages/tui/bench/keystroke-frame.bench.ts
 */
import type { Component, EditorTheme } from "@oh-my-pi/pi-tui";
import { Editor, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../test/render-stress-scheduler";
import { VirtualTerminal } from "../test/virtual-terminal";

const WARMUP_EPISODES = 12;
const MEASURE_EPISODES = 48;
/** Independent one-key timings averaged into each episode sample. */
const KEYS_PER_EPISODE = 3000;
const TRANSCRIPT_ROWS = 15_000;
const COLS = 80;
const ROWS = 24;

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

function robustNoise(xs: number[], center: number): number {
	if (center <= 0 || xs.length === 0) return 0;
	const absDev = xs.map(x => Math.abs(x - center));
	return (1.4826 * median(absDev)) / center;
}

/** Ref-stable leaf: returns the same array when unchanged; counts render() calls. */
class CountingLines implements Component {
	renders = 0;
	#lines: readonly string[];

	constructor(lines: readonly string[]) {
		this.#lines = lines;
	}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		this.renders += 1;
		return this.#lines;
	}
}

function minimalEditorTheme(): EditorTheme {
	const id = (text: string) => text;
	const box = {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		cross: "+",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
	};
	const symbols = {
		cursor: ">",
		inputCursor: "|",
		boxRound: {
			topLeft: "+",
			topRight: "+",
			bottomLeft: "+",
			bottomRight: "+",
			horizontal: "-",
			vertical: "|",
		},
		boxSharp: box,
		table: box,
		quoteBorder: "|",
		hrChar: "-",
		colorSwatch: "[]",
		spinnerFrames: ["-"],
	};
	return {
		borderColor: id,
		selectList: {
			selectedPrefix: id,
			selectedText: id,
			description: id,
			scrollInfo: id,
			noMatch: id,
			symbols,
			hovered: id,
		},
		symbols,
		hintStyle: id,
	};
}

function emitMetric(metric: string, median_ms: number, stddev_ms: number): void {
	// Benches intentionally emit metrics on stdout.
	console.log(JSON.stringify({ metric, median_ms, stddev_ms }));
	console.log(`METRIC ${metric}=${median_ms.toFixed(4)}`);
}

const lines = Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => `history-row-${i}`);
const term = new VirtualTerminal(COLS, ROWS, 2_000);
const scheduler = new StressRenderScheduler();
const tui = new TUI(term, true, { renderScheduler: scheduler });
const transcript = new CountingLines(lines);
const editor = new Editor(minimalEditorTheme());
tui.addChild(transcript);
tui.addChild(editor);
tui.setFocus(editor);
tui.start();
await scheduler.drain(term);

/**
 * One keystroke from a clean empty editor. Reset + editor-scoped paint is
 * outside the timed window so the metric is pure keypress → render-complete for
 * a single printable char (empty → "x"). `setText` alone does not schedule a
 * paint without onChange; requestComponentRender updates the editor segment of
 * the display baseline without re-walking the 15k-row transcript stand-in.
 * The timed path uses sendInput → #handleInput → requestRender (full compose).
 */
async function oneKeyLatency(): Promise<{ ms: number; renders: number }> {
	editor.setText("");
	tui.requestComponentRender(editor);
	await scheduler.drain(term);
	const rendersBefore = transcript.renders;
	const t0 = performance.now();
	term.sendInput("x");
	await scheduler.drain(term);
	return { ms: performance.now() - t0, renders: transcript.renders - rendersBefore };
}

/**
 * Episode sample = mean of KEYS_PER_EPISODE independent single-key latencies
 * (reset outside each timed press). Averaging lifts the sample window above the
 * timer noise floor while keeping the metric as ms per one printable char.
 */
async function episodeSample(): Promise<{ ms: number; rendersPerKey: number }> {
	let totalMs = 0;
	let totalRenders = 0;
	for (let k = 0; k < KEYS_PER_EPISODE; k++) {
		const r = await oneKeyLatency();
		totalMs += r.ms;
		totalRenders += r.renders;
	}
	return {
		ms: totalMs / KEYS_PER_EPISODE,
		rendersPerKey: totalRenders / KEYS_PER_EPISODE,
	};
}

for (let i = 0; i < WARMUP_EPISODES; i++) {
	await episodeSample();
}

const frameSamples: number[] = [];
const renderSamples: number[] = [];

for (let i = 0; i < MEASURE_EPISODES; i++) {
	Bun.gc(true);
	const { ms, rendersPerKey } = await episodeSample();
	frameSamples.push(ms);
	renderSamples.push(rendersPerKey);
}

tui.stop();

const med = median(frameSamples);
const sd = stddev(frameSamples);
const rawNoise = med > 0 ? sd / med : 0;
const noise = robustNoise(frameSamples, med);
// Quiet-frame contract: mean renders/key over ALL episodes (not median of rates —
// a median can be 0 while intermittent recomposes still fire).
const meanRendersPerKey =
	renderSamples.reduce((a, b) => a + b, 0) / Math.max(renderSamples.length, 1);
const maxEpisodeRendersPerKey = renderSamples.reduce((a, b) => Math.max(a, b), 0);

console.log(
	`keystroke-frame: median=${med.toFixed(4)}ms/key stddev=${sd.toFixed(4)}ms ` +
		`noise robust=${(noise * 100).toFixed(1)}% raw=${(rawNoise * 100).toFixed(1)}% ` +
		`episodes=${MEASURE_EPISODES} keys/episode=${KEYS_PER_EPISODE}`,
);
console.log(
	`  transcript renders/keystroke: mean=${meanRendersPerKey.toFixed(4)} ` +
		`maxEpisode=${maxEpisodeRendersPerKey.toFixed(4)} ` +
		`(post WS-B target mean=0 and max=0)`,
);
if (noise > 0.2) {
	console.error(`FAIL: keystroke noise ${(noise * 100).toFixed(1)}% > 20%`);
	process.exitCode = 1;
}
if (med >= 5) {
	console.error(`FAIL: keystroke median ${med.toFixed(4)}ms >= 5ms absolute target`);
	process.exitCode = 1;
}
if (meanRendersPerKey !== 0 || maxEpisodeRendersPerKey !== 0) {
	console.error(
		`FAIL: transcript renders/keystroke must be exactly 0 ` +
			`(mean=${meanRendersPerKey.toFixed(4)} maxEpisode=${maxEpisodeRendersPerKey.toFixed(4)})`,
	);
	process.exitCode = 1;
}

emitMetric("keystroke_frame_ms", med, sd);
// Guard schema reuses median_ms as the scalar; quiet gate = mean over episodes.
console.log(
	JSON.stringify({
		metric: "keystroke_transcript_renders",
		median_ms: meanRendersPerKey,
		stddev_ms: stddev(renderSamples),
	}),
);
console.log(`METRIC keystroke_transcript_renders=${meanRendersPerKey.toFixed(4)}`);
console.log(
	JSON.stringify({
		metric: "keystroke_transcript_renders_max",
		median_ms: maxEpisodeRendersPerKey,
		stddev_ms: 0,
	}),
);
console.log(`METRIC keystroke_transcript_renders_max=${maxEpisodeRendersPerKey.toFixed(4)}`);
