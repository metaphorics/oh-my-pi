import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

type DrainableScheduler = {
	now(): number;
	scheduleImmediate(cb: () => void): void;
	scheduleRender(cb: () => void, delayMs: number): { cancel(): void };
	flush(): void;
};

function makeDrainableScheduler(): DrainableScheduler {
	let clock = 0;
	const queue: Array<{ run: () => void; cancelled: boolean }> = [];
	const enqueue = (cb: () => void) => {
		const item = { run: cb, cancelled: false };
		queue.push(item);
		return item;
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
				const item = queue.shift();
				if (item === undefined) throw new Error("scheduler queue unexpectedly empty");
				clock += 1;
				if (!item.cancelled) item.run();
			}
		},
	};
}

class StaticBlock implements Component {
	constructor(private readonly lines: readonly string[]) {}
	invalidate(): void {}
	render(_width: number): readonly string[] {
		return this.lines;
	}
}

class Footer implements Component {
	constructor(private readonly rows: number) {}
	invalidate(): void {}
	render(_width: number): readonly string[] {
		return Array.from({ length: this.rows }, (_, index) => `editor-${index}`);
	}
}

class VersionedFinalizedBlock implements Component {
	#version = 0;
	#sealed: boolean;
	#lines: readonly string[];

	constructor(lines: readonly string[], sealed = false) {
		this.#lines = lines;
		this.#sealed = sealed;
	}

	mutate(lines: readonly string[]): void {
		this.#lines = lines;
		this.#version++;
	}

	isTranscriptBlockFinalized(): boolean {
		return true;
	}

	sealTranscriptBlock(): void {
		this.#sealed = true;
	}

	isTranscriptBlockSealed(): boolean {
		return this.#sealed;
	}

	getTranscriptBlockVersion(): number {
		return this.#version;
	}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		return [...this.#lines];
	}
}

class ObservedTranscriptContainer extends TranscriptContainer {
	readonly frameLengths: number[] = [];
	replayPreparations = 0;

	override prepareNativeScrollbackReplay(): void {
		this.replayPreparations++;
		super.prepareNativeScrollbackReplay();
	}

	override render(width: number): readonly string[] {
		const frame = super.render(width);
		this.frameLengths.push(frame.length);
		return frame;
	}
}

type Fixture = {
	term: VirtualTerminal;
	scheduler: DrainableScheduler;
	tui: TUI;
	transcript: ObservedTranscriptContainer;
	writes: string[];
};

const width = 80;
const rows = 10;
const headerRows = ["header-above"];
const footerRows = ["editor-0", "editor-1", "editor-2"];

function blockRows(block: number, suffix = ""): string[] {
	return Array.from({ length: 8 }, (_, row) => `block-${block}-row-${row}${suffix}`);
}

function makeFixture(scrollbackRebuild: boolean): Fixture {
	const term = new VirtualTerminal(width, rows, 1_000);
	const writes: string[] = [];
	const write = term.write.bind(term);
	term.write = data => {
		writes.push(data);
		write(data);
	};
	const scheduler = makeDrainableScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	const transcript = new ObservedTranscriptContainer();
	tui.setScrollbackRebuild(scrollbackRebuild);
	tui.addChild(new StaticBlock(headerRows));
	tui.addChild(transcript);
	tui.addChild(new Footer(3));
	return { term, scheduler, tui, transcript, writes };
}

async function flush(fixture: Fixture): Promise<void> {
	fixture.scheduler.flush();
	await fixture.term.flush();
}

async function settle(fixture: Fixture, times = 1): Promise<void> {
	for (let index = 0; index < times; index++) {
		fixture.tui.requestRender();
		await flush(fixture);
	}
}

function plainScrollBuffer(term: VirtualTerminal): string[] {
	return term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
}

function countRows(term: VirtualTerminal, expected: readonly string[]): number[] {
	const buffer = plainScrollBuffer(term);
	return expected.map(row => buffer.filter(candidate => candidate === row).length);
}

function countED3(writes: readonly string[]): number {
	return writes.reduce((count, write) => count + write.split("\x1b[3J").length - 1, 0);
}

function expectRowsExactlyOnce(term: VirtualTerminal, expected: readonly string[], oracle: string): void {
	const buffer = plainScrollBuffer(term);
	const counts = expected.map(row => buffer.filter(candidate => candidate === row).length);
	expect(counts, `${oracle}: row occurrence counts; buffer=${JSON.stringify(buffer)}`).toEqual(expected.map(() => 1));
}

function expectNoDuplicateNonBlankRows(term: VirtualTerminal, oracle: string): void {
	const nonBlank = plainScrollBuffer(term).filter(Boolean);
	const occurrences = new Map<string, number>();
	for (const row of nonBlank) occurrences.set(row, (occurrences.get(row) ?? 0) + 1);
	const duplicates = [...occurrences].filter(([, count]) => count > 1);
	expect(
		new Set(nonBlank).size,
		`${oracle}: unique non-blank row count; duplicates=${JSON.stringify(duplicates)}`,
	).toBe(nonBlank.length);
}

async function addThreeBlocks(fixture: Fixture): Promise<VersionedFinalizedBlock[]> {
	const blocks = [1, 2, 3].map(block => new VersionedFinalizedBlock(blockRows(block)));
	fixture.transcript.addChild(blocks[0]);
	await settle(fixture, 2);
	blocks[0]?.sealTranscriptBlock();
	fixture.transcript.addChild(blocks[1]);
	await settle(fixture, 2);
	blocks[1]?.sealTranscriptBlock();
	fixture.transcript.addChild(blocks[2]);
	await settle(fixture, 6);
	return blocks;
}

const directTerminalEnvKeys = [
	"TERM",
	"TERM_PROGRAM",
	"PI_TUI_RESIZE_IN_PLACE",
	"TMUX",
	"STY",
	"ZELLIJ",
	"CMUX_WORKSPACE_ID",
	"CMUX_SURFACE_ID",
] as const;
const savedDirectTerminalEnv: Partial<Record<(typeof directTerminalEnvKeys)[number], string>> = {};

beforeEach(() => {
	for (const key of directTerminalEnvKeys) {
		const value = Bun.env[key];
		if (value !== undefined) savedDirectTerminalEnv[key] = value;
		delete Bun.env[key];
	}
	Bun.env.TERM = "xterm-256color";
	Bun.env.PI_TUI_RESIZE_IN_PLACE = "0";
});

afterEach(() => {
	for (const key of directTerminalEnvKeys) {
		const value = savedDirectTerminalEnv[key];
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
		delete savedDirectTerminalEnv[key];
	}
});

describe("transcript prefix compaction preserves native scrollback", () => {
	test("rebuild on keeps compacted, mutated, resized, and reattached history exactly once", async () => {
		const fixture = makeFixture(true);
		try {
			fixture.tui.start();
			await flush(fixture);
			const blocks = await addThreeBlocks(fixture);
			const block1 = blockRows(1);
			const largestFrame = Math.max(...fixture.transcript.frameLengths);
			const latestFrame = fixture.transcript.frameLengths.at(-1) ?? largestFrame;
			expect(latestFrame, "Step 1: transcript compaction shrinks the rendered frame").toBeLessThan(largestFrame);
			expectRowsExactlyOnce(fixture.term, block1, "Oracle A");

			const ed3AfterCompaction = countED3(fixture.writes);
			expect(ed3AfterCompaction, "Step 1: compaction ED3 count").toBe(0);
			await settle(fixture, 5);
			expect(countED3(fixture.writes), "Oracle B: ED3 count after five no-op settles").toBe(ed3AfterCompaction);

			const block3 = blocks[2];
			if (block3 === undefined) throw new Error("third transcript block was not created");
			const successorRows = blockRows(4, "-successor");
			const successor = new VersionedFinalizedBlock(successorRows);
			fixture.transcript.addChild(successor);
			await settle(fixture);
			const ed3BeforeMutation = countED3(fixture.writes);
			const updatedBlock3 = blockRows(3, "-updated");
			block3.sealTranscriptBlock();
			block3.mutate(updatedBlock3);
			await settle(fixture);
			expect(countED3(fixture.writes) - ed3BeforeMutation, "Step 2: version mutation replay count").toBe(1);
			expectRowsExactlyOnce(fixture.term, updatedBlock3, "Step 2: pre-compaction version mutation");
			expect(countRows(fixture.term, blockRows(3)), "Step 2: stale pre-mutation rows removed by replay").toEqual(
				blockRows(3).map(() => 0),
			);
			await settle(fixture, 5);
			fixture.transcript.removeChild(successor);
			const replayPreparationsBeforeResize = fixture.transcript.replayPreparations;
			const ed3BeforeResize = countED3(fixture.writes);
			const writesBeforeResize = fixture.writes.length;
			const framesBeforeResize = fixture.transcript.frameLengths.length;
			fixture.term.resize(width - 10, rows);
			await settle(fixture, 5);
			expect(
				fixture.transcript.replayPreparations,
				"Step 3: resize prepares compacted transcript replay",
			).toBeGreaterThan(replayPreparationsBeforeResize);
			expect(countED3(fixture.writes) - ed3BeforeResize, "Step 3: resize emits one destructive replay").toBe(1);
			const resizeReplayWrite = fixture.writes.slice(writesBeforeResize).find(write => write.includes("\x1b[3J"));
			expect(resizeReplayWrite, "Step 3: resize ED3 write exists").toBeDefined();
			const resizeWrites = fixture.writes.slice(writesBeforeResize).join("");
			expect(
				resizeWrites.includes("block-1-row-0"),
				`Step 3: resize writes contain compacted history; frames=${fixture.transcript.frameLengths.slice(framesBeforeResize).join(",")}`,
			).toBe(true);
			const allUpdatedRows = [...blockRows(1), ...blockRows(2), ...updatedBlock3];
			expectRowsExactlyOnce(fixture.term, allUpdatedRows, "Step 3: resize replay");

			fixture.transcript.clear();
			for (let block = 1; block <= 3; block++) {
				fixture.transcript.addChild(new VersionedFinalizedBlock(blockRows(block, "-reattached"), true));
			}
			const ed3BeforeAttach = countED3(fixture.writes);
			fixture.tui.requestRender(true, { clearScrollback: true });
			await flush(fixture);
			const reattachedRows = [
				...blockRows(1, "-reattached"),
				...blockRows(2, "-reattached"),
				...blockRows(3, "-reattached"),
			];
			expectRowsExactlyOnce(fixture.term, reattachedRows, "Step 5: focus-attach replay");
			const ed3AfterAttach = countED3(fixture.writes);
			expect(ed3AfterAttach - ed3BeforeAttach, "Step 5: focus-attach replay count").toBe(1);
			const frameBeforePostAttachCompaction = fixture.transcript.frameLengths.at(-1) ?? 0;
			await settle(fixture);
			const frameAfterPostAttachCompaction = fixture.transcript.frameLengths.at(-1) ?? 0;
			expect(
				frameAfterPostAttachCompaction,
				"Step 5: ordinary frame after attach compacts the rehydrated transcript",
			).toBeLessThan(frameBeforePostAttachCompaction);
			expect(countED3(fixture.writes), "Step 5: post-attach compaction does not trigger another ED3").toBe(
				ed3AfterAttach,
			);
			expectRowsExactlyOnce(fixture.term, reattachedRows, "Step 5: post-compaction history");
			expectNoDuplicateNonBlankRows(fixture.term, "Step 5");
		} finally {
			fixture.tui.stop();
			await fixture.term.flush();
		}
	});

	test("rebuild off compacts without duplicating non-blank history", async () => {
		const fixture = makeFixture(false);
		try {
			fixture.tui.start();
			await flush(fixture);
			await addThreeBlocks(fixture);
			expectRowsExactlyOnce(fixture.term, blockRows(1), "Step 4: rebuild-off compacted block");
			expectNoDuplicateNonBlankRows(fixture.term, "Step 4: rebuild off");
			expectRowsExactlyOnce(
				fixture.term,
				[...headerRows, ...blockRows(1), ...blockRows(2), ...blockRows(3), ...footerRows],
				"Step 4: complete rebuild-off history",
			);
		} finally {
			fixture.tui.stop();
			await fixture.term.flush();
		}
	});
});
