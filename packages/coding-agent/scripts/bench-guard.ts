#!/usr/bin/env bun
/**
 * Local wall-clock regression guard for coding-agent / TUI long-session benches.
 *
 * Multi-entry table:
 *  - boot: hyperfine cold-boot (`PI_TIMING=x`) — stores raw hyperfine JSON
 *  - json-line benches: run script, parse stdout JSON `{metric,median_ms,stddev_ms}`
 *
 * Boot wall-clock is MACHINE-RELATIVE: a baseline captured on one machine is
 * meaningless on another (and on CI). This is a LOCAL guard — regenerate the
 * baseline on the machine you measure on, then compare on that same machine.
 * It is intentionally NOT wired into CI for that reason.
 *
 *   bun scripts/bench-guard.ts --update          # refresh all baselines
 *   bun scripts/bench-guard.ts                   # measure + compare; exit 1 on regression
 *   bun scripts/bench-guard.ts --only=boot,keystroke-frame
 *
 * Hyperfine is required only for the boot entry. Json-line entries run without it.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const THRESHOLD = 1.05; // 5% regression budget
const codingAgentRoot = path.join(import.meta.dir, "..");
const monorepoRoot = path.join(codingAgentRoot, "..", "..");
const benchDir = path.join(codingAgentRoot, "bench");

type HyperfineEntry = {
	name: string;
	mode: "hyperfine";
	/** Shell command relative to coding-agent package cwd. */
	command: string;
	baselinePath: string;
	cwd: string;
};

type JsonLineEntry = {
	name: string;
	mode: "json-line";
	/** argv for Bun.spawn (no shell). Paths relative to monorepo root. */
	args: string[];
	baselinePath: string;
	/** Metric name expected on a JSON stdout line. */
	metric: string;
	cwd: string;
};

type BenchEntry = HyperfineEntry | JsonLineEntry;

const ENTRIES: BenchEntry[] = [
	{
		name: "boot",
		mode: "hyperfine",
		command: "PI_TIMING=x PI_STRICT_EDIT_MODE=1 bun src/cli.ts",
		baselinePath: path.join(benchDir, "boot-baseline.json"),
		cwd: codingAgentRoot,
	},
	{
		name: "transcript-compose",
		mode: "json-line",
		args: ["run", "packages/coding-agent/bench/transcript-compose.bench.ts"],
		baselinePath: path.join(benchDir, "transcript-compose-baseline.json"),
		metric: "transcript_compose_n5000_ms",
		cwd: monorepoRoot,
	},
	{
		name: "keystroke-frame",
		mode: "json-line",
		args: ["run", "packages/tui/bench/keystroke-frame.bench.ts"],
		baselinePath: path.join(benchDir, "keystroke-frame-baseline.json"),
		metric: "keystroke_frame_ms",
		cwd: monorepoRoot,
	},
	{
		name: "llm-assembly",
		mode: "json-line",
		args: ["run", "packages/coding-agent/bench/llm-assembly.bench.ts"],
		baselinePath: path.join(benchDir, "llm-assembly-baseline.json"),
		metric: "llm_assembly_convert_ms",
		cwd: monorepoRoot,
	},
	{
		name: "keystroke-transcript-renders",
		mode: "json-line",
		args: ["run", "packages/tui/bench/keystroke-frame.bench.ts"],
		baselinePath: path.join(benchDir, "keystroke-transcript-renders-baseline.json"),
		metric: "keystroke_transcript_renders",
		cwd: monorepoRoot,
	},
	{
		name: "session-dispose",
		mode: "json-line",
		args: ["run", "packages/coding-agent/bench/session-dispose.bench.ts"],
		baselinePath: path.join(benchDir, "session-dispose-baseline.json"),
		metric: "session.dispose.idle_ms",
		cwd: monorepoRoot,
	},
];

type JsonMetric = {
	metric: string;
	median_ms: number;
	stddev_ms: number;
	captured_at?: string;
};

function parseArgs(argv: string[]): { update: boolean; only: Set<string> | undefined; help: boolean } {
	let update = false;
	let help = false;
	let only: Set<string> | undefined;
	for (const arg of argv) {
		if (arg === "--update") update = true;
		else if (arg === "--help" || arg === "-h") help = true;
		else if (arg.startsWith("--only=")) {
			only = new Set(
				arg
					.slice("--only=".length)
					.split(",")
					.map(s => s.trim())
					.filter(Boolean),
			);
		}
	}
	return { update, only, help };
}

function medianOfHyperfine(hyperfineJson: string): number {
	const parsed = JSON.parse(hyperfineJson) as { results: Array<{ mean: number; median?: number }> };
	const result = parsed.results[0];
	if (!result) throw new Error("hyperfine produced no result");
	return result.median ?? result.mean;
}

function parseJsonMetricLines(stdout: string, metric: string): JsonMetric {
	const lines = stdout.split("\n");
	let last: JsonMetric | undefined;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const obj = JSON.parse(trimmed) as Partial<JsonMetric>;
			if (obj.metric === metric && typeof obj.median_ms === "number" && Number.isFinite(obj.median_ms)) {
				// Timing metrics should be >0; count metrics (e.g. renders) may be 0 post-WS-B.
				const allowZero = metric === "keystroke_transcript_renders";
				if (obj.median_ms > 0 || (allowZero && obj.median_ms === 0)) {
					const sd = typeof obj.stddev_ms === "number" && Number.isFinite(obj.stddev_ms) ? obj.stddev_ms : 0;
					last = {
						metric: obj.metric,
						median_ms: obj.median_ms,
						stddev_ms: sd,
					};
				}
			}
		} catch {
			// non-JSON noise
		}
	}
	if (!last) {
		throw new Error(`no finite JSON metric line for ${metric} in bench stdout`);
	}
	return last;
}

async function measureHyperfine(entry: HyperfineEntry): Promise<{ seconds: number; raw: string }> {
	const which = Bun.spawn(["bash", "-lc", "command -v hyperfine"], { stdout: "pipe", stderr: "pipe" });
	const whichCode = await which.exited;
	if (whichCode !== 0) {
		throw new Error(
			`hyperfine not on PATH (required only for boot entry). Install hyperfine or run with --only=transcript-compose,keystroke-frame,llm-assembly`,
		);
	}
	const tmp = path.join(benchDir, `.boot-run-${Date.now()}.json`);
	const proc = Bun.spawn(["hyperfine", "--warmup", "3", "--min-runs", "10", "--export-json", tmp, entry.command], {
		cwd: entry.cwd,
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await proc.exited;
	if (code !== 0) throw new Error(`hyperfine exited ${code}`);
	const raw = await Bun.file(tmp).text();
	fs.rmSync(tmp, { force: true });
	return { seconds: medianOfHyperfine(raw), raw };
}

async function measureJsonLine(entry: JsonLineEntry): Promise<JsonMetric> {
	const proc = Bun.spawn(["bun", ...entry.args], {
		cwd: entry.cwd,
		stdout: "pipe",
		stderr: "inherit",
	});
	const stdout = await new Response(proc.stdout).text();
	const code = await proc.exited;
	// Still try to parse metrics even if the process printed warnings.
	const metric = parseJsonMetricLines(stdout, entry.metric);
	if (code !== 0) {
		throw new Error(`bench ${entry.name} exited ${code}`);
	}
	return metric;
}

function printHelp(): void {
	console.log(`Usage: bun scripts/bench-guard.ts [--update] [--only=name,...]

Entries:
${ENTRIES.map(e => `  - ${e.name} (${e.mode})`).join("\n")}

Exit codes: 0 ok, 1 regression, 2 missing baseline / measure failure.
Wall-clock is MACHINE-RELATIVE and NOT CI-wired.`);
}

const { update, only, help } = parseArgs(process.argv.slice(2));
if (help) {
	printHelp();
	process.exit(0);
}

const selected = ENTRIES.filter(e => !only || only.has(e.name));
if (selected.length === 0) {
	console.error("No matching entries. Known:", ENTRIES.map(e => e.name).join(", "));
	process.exit(2);
}

let exitCode = 0;
let missingBaseline = false;

for (const entry of selected) {
	try {
		if (entry.mode === "hyperfine") {
			const { seconds, raw } = await measureHyperfine(entry);
			if (update) {
				fs.mkdirSync(path.dirname(entry.baselinePath), { recursive: true });
				await Bun.write(entry.baselinePath, raw);
				console.log(
					`[${entry.name}] Baseline updated: ${(seconds * 1000).toFixed(0)}ms median -> ${entry.baselinePath}`,
				);
				continue;
			}
			if (!fs.existsSync(entry.baselinePath)) {
				console.error(
					`[${entry.name}] No baseline found. Run \`bun scripts/bench-guard.ts --update\` on this machine first.`,
				);
				missingBaseline = true;
				continue;
			}
			const baseline = medianOfHyperfine(await Bun.file(entry.baselinePath).text());
			const ratio = seconds / baseline;
			const verdict = ratio > THRESHOLD ? "REGRESSION" : "ok";
			console.log(
				`[${entry.name}] median: ${(seconds * 1000).toFixed(0)}ms vs baseline ${(baseline * 1000).toFixed(0)}ms ` +
					`(${((ratio - 1) * 100).toFixed(1)}%, budget ${((THRESHOLD - 1) * 100).toFixed(0)}%) -> ${verdict}`,
			);
			if (ratio > THRESHOLD) exitCode = 1;
		} else {
			const measured = await measureJsonLine(entry);
			if (update) {
				const payload: JsonMetric = {
					...measured,
					captured_at: new Date().toISOString(),
				};
				fs.mkdirSync(path.dirname(entry.baselinePath), { recursive: true });
				await Bun.write(entry.baselinePath, `${JSON.stringify(payload, null, 2)}\n`);
				console.log(
					`[${entry.name}] Baseline updated: ${measured.median_ms.toFixed(4)}ms (${measured.metric}) -> ${entry.baselinePath}`,
				);
				continue;
			}
			if (!fs.existsSync(entry.baselinePath)) {
				console.error(
					`[${entry.name}] No baseline found. Run \`bun scripts/bench-guard.ts --update --only=${entry.name}\` on this machine first.`,
				);
				missingBaseline = true;
				continue;
			}
			const baselineRaw = JSON.parse(await Bun.file(entry.baselinePath).text()) as Partial<JsonMetric>;
			const baselineMs = baselineRaw.median_ms;
			if (typeof baselineMs !== "number" || !Number.isFinite(baselineMs) || baselineMs < 0) {
				throw new Error(`invalid baseline for ${entry.name}: median_ms must be finite and >= 0`);
			}
			if (baselineMs === 0) {
				// Count metrics may baseline at 0 (post-WS-B renders). Any rise is a regression.
				const verdict = measured.median_ms > 0 ? "REGRESSION" : "ok";
				console.log(
					`[${entry.name}] ${measured.metric}: ${measured.median_ms.toFixed(4)} vs baseline 0 -> ${verdict}`,
				);
				if (measured.median_ms > 0) exitCode = 1;
				continue;
			}
			const ratio = measured.median_ms / baselineMs;
			const verdict = ratio > THRESHOLD ? "REGRESSION" : "ok";
			console.log(
				`[${entry.name}] ${measured.metric}: ${measured.median_ms.toFixed(4)}ms vs baseline ${baselineMs.toFixed(4)}ms ` +
					`(${((ratio - 1) * 100).toFixed(1)}%, budget ${((THRESHOLD - 1) * 100).toFixed(0)}%) -> ${verdict}`,
			);
			if (ratio > THRESHOLD) exitCode = 1;
		}
	} catch (err) {
		console.error(`[${entry.name}] ${err instanceof Error ? err.message : String(err)}`);
		// Treat measure failures as missing/setup (exit 2) rather than silent ok.
		missingBaseline = true;
	}
}

if (missingBaseline) process.exit(2);
process.exit(exitCode);
