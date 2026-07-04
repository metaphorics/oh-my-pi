import { describe, expect, it } from "bun:test";
import { executePythonWithKernel } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import { FakeKernel } from "./helpers";

describe("executePythonWithKernel streaming", () => {
	it("truncates large output and tracks totals", async () => {
		const largeOutput = "a".repeat(DEFAULT_MAX_BYTES + 128);
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: false, timedOut: false, stdinRequested: false },
			options => options?.onChunk?.(largeOutput),
		);

		const result = await executePythonWithKernel(kernel, "print('hi')");

		expect(result.truncated).toBe(true);
		expect(result.output.length).toBeLessThan(largeOutput.length);
		expect(result.totalBytes).toBeGreaterThan(result.outputBytes);
	});
});
