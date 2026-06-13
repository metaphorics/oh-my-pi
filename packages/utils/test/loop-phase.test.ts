import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { currentLoopPhase, popLoopPhase, pushLoopPhase } from "@oh-my-pi/pi-utils";

/**
 * Contract: the loop-phase breadcrumb is a LIFO string stack. `currentLoopPhase()`
 * reports the most recently pushed, still-unpopped label and `undefined` once the
 * stack drains. The watchdog reads this to name the work that blocked the loop, so
 * the ordering and empty-state behavior are the externally observable guarantee.
 *
 * The stack is a process-global; drain it around each case so a leaked phase from
 * this or any other suite cannot poison an assertion or leak outward.
 */
function drain(): void {
	while (currentLoopPhase() !== undefined) popLoopPhase();
}

beforeEach(drain);
afterEach(drain);

describe("loop phase stack", () => {
	test("currentLoopPhase() is undefined on an empty stack", () => {
		expect(currentLoopPhase()).toBeUndefined();
	});

	test("push/pop expose the top label in strict LIFO order through nested phases", () => {
		pushLoopPhase("render");
		expect(currentLoopPhase()).toBe("render");

		pushLoopPhase("layout");
		expect(currentLoopPhase()).toBe("layout");

		pushLoopPhase("paint");
		expect(currentLoopPhase()).toBe("paint");

		// Unwinding reveals each enclosing phase in reverse insertion order.
		popLoopPhase();
		expect(currentLoopPhase()).toBe("layout");

		popLoopPhase();
		expect(currentLoopPhase()).toBe("render");

		popLoopPhase();
		expect(currentLoopPhase()).toBeUndefined();
	});

	test("popping an already-empty stack stays undefined without underflow", () => {
		// Unbalanced pops (error paths popping more than they pushed) must not throw
		// or wrap around to a stale label.
		popLoopPhase();
		popLoopPhase();
		expect(currentLoopPhase()).toBeUndefined();

		// And the stack is still usable afterward.
		pushLoopPhase("after-underflow");
		expect(currentLoopPhase()).toBe("after-underflow");
	});
});
