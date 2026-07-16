import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type Component,
	type NativeScrollbackCommittedRows,
	type NativeScrollbackLiveRegion,
	type NativeScrollbackReplay,
	type NativeScrollbackVirtualizedPrefix,
	type RenderStablePrefix,
	Text,
	TUI,
} from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

type DrainableScheduler = {
	now(): number;
	scheduleImmediate(cb: () => void): void;
	scheduleRender(cb: () => void, delayMs: number): { cancel(): void };
	flush(): void;
	flushUntil(predicate: () => boolean): void;
};

function makeDrainableScheduler(): DrainableScheduler {
	let clock = 0;
	const queue: Array<{ run: () => void; cancelled: boolean }> = [];
	const enqueue = (cb: () => void) => {
		const item = { run: cb, cancelled: false };
		queue.push(item);
		return item;
	};
	const runOne = () => {
		const item = queue.shift();
		if (!item) return;
		clock += 1;
		if (!item.cancelled) item.run();
	};
	return {
		now: () => clock,
		scheduleImmediate(cb) {
			enqueue(cb);
		},
		scheduleRender(cb) {
			const item = enqueue(cb);
			return {
				cancel() {
					item.cancelled = true;
				},
			};
		},
		flush() {
			let guard = 0;
			while (queue.length > 0) {
				if (++guard > 100_000) throw new Error("scheduler did not settle");
				runOne();
			}
		},
		flushUntil(predicate) {
			let guard = 0;
			while (!predicate()) {
				if (++guard > 100_000 || queue.length === 0) throw new Error("scheduler condition did not settle");
				runOne();
			}
		},
	};
}

class Footer implements Component {
	invalidate(): void {}

	render(_width: number): readonly string[] {
		return ["footer-0", "footer-1"];
	}
}

class VirtualizingComponent
	implements
		Component,
		NativeScrollbackCommittedRows,
		NativeScrollbackReplay,
		NativeScrollbackVirtualizedPrefix,
		NativeScrollbackLiveRegion,
		RenderStablePrefix
{
	readonly rows: string[] = [];
	replayPreparations = 0;
	committedRows = 0;
	renderCalls = 0;
	#firstVisibleRow = 0;
	#pendingDropRows = 0;
	#stablePrefixRows = 0;
	#lastRenderRows = 0;
	#liveRegionStart: number | undefined = 10;

	invalidate(): void {}

	setNativeScrollbackCommittedRows(rows: number): void {
		this.committedRows = rows;
	}
	growRows(count: number): void {
		const start = this.rows.length;
		this.#stablePrefixRows = start;
		for (let index = start; index < start + count; index++) {
			this.rows.push(`virtual-row-${index.toString().padStart(2, "0")}`);
		}
	}

	dropCommittedTop(rows: number): void {
		const dropped = Math.min(rows, this.committedRows);
		this.#firstVisibleRow += dropped;
		this.#pendingDropRows += dropped;
		this.#stablePrefixRows = 0;
	}

	rewriteCommittedVisibleRow(index: number, text: string): void {
		if (index >= this.committedRows) throw new Error("row must already be committed");
		this.rows[this.#firstVisibleRow + index] = text;
		this.#stablePrefixRows = index;
	}
	finalize(): void {
		this.#liveRegionStart = undefined;
	}

	takeNativeScrollbackVirtualizedRows(): number {
		const rows = this.#pendingDropRows;
		this.#pendingDropRows = 0;
		return rows;
	}

	prepareNativeScrollbackReplay(): void {
		this.replayPreparations++;
		this.#firstVisibleRow = 0;
		this.#pendingDropRows = 0;
		this.#stablePrefixRows = 0;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#liveRegionStart;
	}

	getRenderStablePrefixRows(): number {
		const rows = this.#stablePrefixRows;
		this.#stablePrefixRows = this.#lastRenderRows;
		return rows;
	}

	render(_width: number): readonly string[] {
		this.renderCalls++;
		const rows = this.rows.slice(this.#firstVisibleRow);
		this.#lastRenderRows = rows.length;
		return rows;
	}
}

type Fixture = {
	term: VirtualTerminal;
	scheduler: DrainableScheduler;
	tui: TUI;
	virtualized: VirtualizingComponent;
	writes: string[];
};

function makeFixture(scrollbackRebuild: boolean): Fixture {
	const term = new VirtualTerminal(80, 10, 1_000);
	const writes: string[] = [];
	const write = term.write.bind(term);
	term.write = data => {
		writes.push(data);
		write(data);
	};
	const scheduler = makeDrainableScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	const virtualized = new VirtualizingComponent();
	tui.setScrollbackRebuild(scrollbackRebuild);
	tui.addChild(new Text("header-above-0\nheader-above-1", 0, 0));
	tui.addChild(virtualized);
	tui.addChild(new Footer());
	return { term, scheduler, tui, virtualized, writes };
}

async function startAndSettle(fixture: Fixture): Promise<void> {
	fixture.tui.start();
	fixture.scheduler.flush();
	await fixture.term.flush();
	fixture.virtualized.growRows(30);
	await settle(fixture);
	expect(fixture.virtualized.committedRows).toBeGreaterThanOrEqual(5);
}

async function settle(fixture: Fixture): Promise<void> {
	fixture.tui.requestRender();
	fixture.scheduler.flush();
	await fixture.term.flush();
}

function plainBuffer(term: VirtualTerminal): string[] {
	return term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
}

function countED3(writes: readonly string[]): number {
	return writes.reduce((count, write) => count + write.split("\x1b[3J").length - 1, 0);
}

function expectExactlyOnce(term: VirtualTerminal, expectedRows: readonly string[]): void {
	const rows = plainBuffer(term);
	for (const expected of expectedRows) {
		expect(rows.filter(row => row === expected).length).toBe(1);
	}
	const nonBlankRows = rows.filter(Boolean);
	expect(new Set(nonBlankRows).size).toBe(nonBlankRows.length);
}

const headers = ["header-above-0", "header-above-1"];
const footers = ["footer-0", "footer-1"];

const directTerminalEnvKeys = ["TERM_PROGRAM", "PI_TUI_RESIZE_IN_PLACE", "TMUX", "STY", "ZELLIJ"] as const;
const savedDirectTerminalEnv: Partial<Record<(typeof directTerminalEnvKeys)[number], string>> = {};

beforeEach(() => {
	for (const key of directTerminalEnvKeys) {
		const value = Bun.env[key];
		if (value !== undefined) savedDirectTerminalEnv[key] = value;
		delete Bun.env[key];
	}
});

afterEach(() => {
	for (const key of directTerminalEnvKeys) {
		const value = savedDirectTerminalEnv[key];
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
		delete savedDirectTerminalEnv[key];
	}
});

describe("native scrollback virtualized-prefix rebasing", () => {
	test("case A: rebuild off preserves dropped rows exactly once without ED3", async () => {
		const fixture = makeFixture(false);
		try {
			await startAndSettle(fixture);
			const ed3BeforeDrop = countED3(fixture.writes);
			const dropped = fixture.virtualized.rows.slice(0, 5);
			fixture.virtualized.dropCommittedTop(5);
			await settle(fixture);

			expect(countED3(fixture.writes) - ed3BeforeDrop).toBe(0);
			for (const row of dropped) {
				expect(plainBuffer(fixture.term).filter(candidate => candidate === row).length).toBe(1);
			}
			expectExactlyOnce(fixture.term, [...headers, ...fixture.virtualized.rows, ...footers]);
		} finally {
			fixture.tui.stop();
			await fixture.term.flush();
		}
	});

	test("case B: a nonzero component start preserves rows above the virtualized segment", async () => {
		const fixture = makeFixture(false);
		try {
			await startAndSettle(fixture);
			fixture.virtualized.dropCommittedTop(5);
			await settle(fixture);

			const nonBlankRows = plainBuffer(fixture.term).filter(Boolean);
			expect(nonBlankRows.slice(0, 2)).toEqual(headers);
			expect(nonBlankRows.filter(row => row === headers[0]).length).toBe(1);
			expect(nonBlankRows.filter(row => row === headers[1]).length).toBe(1);
		} finally {
			fixture.tui.stop();
			await fixture.term.flush();
		}
	});

	test("case C: an epoch-gated real divergence defers ED3 until a complete replay", async () => {
		const fixture = makeFixture(true);
		try {
			await startAndSettle(fixture);
			fixture.virtualized.dropCommittedTop(5);
			await settle(fixture);
			const ed3BeforeDivergence = countED3(fixture.writes);

			fixture.virtualized.rewriteCommittedVisibleRow(12, "virtual-row-17-updated");
			fixture.virtualized.finalize();
			const rendersBeforeDivergence = fixture.virtualized.renderCalls;
			fixture.tui.requestRender();
			fixture.scheduler.flushUntil(() => fixture.virtualized.renderCalls > rendersBeforeDivergence);
			await fixture.term.flush();
			expect(countED3(fixture.writes) - ed3BeforeDivergence).toBe(0);
			const divergenceBuffer = plainBuffer(fixture.term);
			expect(
				fixture.virtualized.rows.some(row => divergenceBuffer.filter(candidate => candidate === row).length > 1),
			).toBe(true);

			fixture.scheduler.flush();
			await fixture.term.flush();
			expect(countED3(fixture.writes) - ed3BeforeDivergence).toBe(1);
			expect(fixture.virtualized.replayPreparations).toBe(1);
			expectExactlyOnce(fixture.term, [...headers, ...fixture.virtualized.rows, ...footers]);
		} finally {
			fixture.tui.stop();
			await fixture.term.flush();
		}
	});

	test("case D: width resize rehydrates virtualized history exactly once", async () => {
		const fixture = makeFixture(false);
		try {
			await startAndSettle(fixture);
			fixture.virtualized.dropCommittedTop(5);
			await settle(fixture);

			fixture.term.resize(70, 10);
			fixture.scheduler.flush();
			await fixture.term.flush();

			expect(fixture.virtualized.replayPreparations).toBeGreaterThanOrEqual(1);
			expectExactlyOnce(fixture.term, [...headers, ...fixture.virtualized.rows, ...footers]);
		} finally {
			fixture.tui.stop();
			await fixture.term.flush();
		}
	});
});
