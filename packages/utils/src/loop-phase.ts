/**
 * Live event-loop phase breadcrumb. Hot synchronous paths push a short label
 * before running and pop it after (via `try`/`finally`); the loop watchdog
 * reads {@link currentLoopPhase} when it detects a block, so a stall is logged
 * with the work that caused it instead of an opaque "unknown".
 *
 * This is deliberately a process-global stack and not part of the logger span
 * machinery: `main.ts` ends timing spans before the interactive TUI starts, so
 * `logger.openSpanPath()` is empty in a live session.
 */
const stack: string[] = [];

export function pushLoopPhase(label: string): void {
	stack.push(label);
}

export function popLoopPhase(): void {
	stack.pop();
}

export function currentLoopPhase(): string | undefined {
	return stack[stack.length - 1];
}
