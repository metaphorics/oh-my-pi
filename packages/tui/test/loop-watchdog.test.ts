import { afterEach, describe, expect, test, vi } from "bun:test";
import { LoopWatchdog } from "@oh-my-pi/pi-tui/loop-watchdog";
import { currentLoopPhase, logger, popLoopPhase, pushLoopPhase } from "@oh-my-pi/pi-utils";

/**
 * Contract: LoopWatchdog turns event-loop lag into exactly one
 * `logger.warn("ui.loop-blocked", { blockedMs, phase })` line per block. A tick
 * that fires more than `thresholdMs` past its `intervalMs` deadline is a block; it
 * is logged once on the rising edge (deduped while the loop stays blocked), tagged
 * with the current loop phase and the rounded overshoot, and a stopped watchdog
 * emits nothing even for a tick already armed before stop().
 *
 * Time and the timer are injected so the test drives elapsed time deterministically
 * instead of sleeping. `schedule` captures the armed callback so the test fires
 * ticks by hand; firing re-arms via schedule, so the captured callback always
 * advances to the next pending tick.
 */
function harness(options: Partial<{ intervalMs: number; thresholdMs: number }> = {}) {
	let nowValue = 0;
	let scheduled: (() => void) | undefined;
	const now = () => nowValue;
	const schedule = (cb: () => void) => {
		scheduled = cb;
		return {};
	};
	const wd = new LoopWatchdog({ now, schedule, ...options });
	return {
		wd,
		setNow(value: number): void {
			nowValue = value;
		},
		fireTick(): void {
			const cb = scheduled;
			if (!cb) throw new Error("no tick was scheduled");
			cb();
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	// The phase stack is a process-global; drain anything these cases pushed.
	while (currentLoopPhase() !== undefined) popLoopPhase();
});

describe("LoopWatchdog", () => {
	test("logs ui.loop-blocked once with the current phase and overshoot when a tick runs late", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness(); // intervalMs=250, thresholdMs=250

		pushLoopPhase("render");
		wd.start(); // deadline armed at now(0)+250 = 250
		setNow(560); // tick fires at 560 → blockedMs = 560 - 250 = 310 (> threshold)
		fireTick();

		expect(warnSpy).toHaveBeenCalledTimes(1);
		const [event, ctx] = warnSpy.mock.calls[0] as [string, { blockedMs: number; phase: string }];
		expect(event).toBe("ui.loop-blocked");
		expect(ctx.phase).toBe("render");
		expect(ctx.blockedMs).toBeGreaterThanOrEqual(250);
	});

	test("stays silent when a tick fires on its deadline", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		pushLoopPhase("render");
		wd.start(); // deadline at 250
		setNow(250); // blockedMs = 0, not a block
		fireTick();

		expect(warnSpy).not.toHaveBeenCalled();
	});

	test("dedupes a sustained block: two consecutive late ticks log only once", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		pushLoopPhase("render");
		wd.start(); // deadline at 250
		setNow(600); // blockedMs = 350 → rising edge, logs once; re-armed deadline = 850
		fireTick();
		setNow(1200); // blockedMs = 350 again, but still blocked → no second log
		fireTick();

		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	test("emits nothing for a tick that fires after stop()", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		pushLoopPhase("render");
		wd.start(); // deadline at 250
		setNow(600); // first block logs once and re-arms a follow-up tick
		fireTick();
		expect(warnSpy).toHaveBeenCalledTimes(1);

		wd.stop();
		setNow(5000); // the already-armed follow-up tick would otherwise be a huge block
		fireTick();

		expect(warnSpy).toHaveBeenCalledTimes(1); // stop() short-circuits the stale tick
	});
});
