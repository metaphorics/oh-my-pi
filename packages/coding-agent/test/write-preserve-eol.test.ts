import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	};
}

describe("write tool line endings", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-eol-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
	});

	it("preserves CRLF when overwriting an existing CRLF file", async () => {
		const target = path.join(tempDir, "crlf.txt");
		await Bun.write(target, "old\r\nvalue\r\n");

		await new WriteTool(createSession(tempDir)).execute("write-crlf", {
			path: target,
			content: "new\nvalue\n",
		});

		expect(await Bun.file(target).text()).toBe("new\r\nvalue\r\n");
	});

	it("keeps LF when overwriting an existing LF file", async () => {
		const target = path.join(tempDir, "lf.txt");
		await Bun.write(target, "old\nvalue\n");

		await new WriteTool(createSession(tempDir)).execute("write-lf", {
			path: target,
			content: "new\nvalue\n",
		});

		expect(await Bun.file(target).text()).toBe("new\nvalue\n");
	});

	it("does not normalize a single-line overwrite", async () => {
		const target = path.join(tempDir, "single-line.txt");
		await Bun.write(target, "old\r\nvalue\r\n");

		await new WriteTool(createSession(tempDir)).execute("write-single-line", {
			path: target,
			content: "new",
		});

		expect(await Bun.file(target).text()).toBe("new");
	});

	it("keeps new-file writes unchanged", async () => {
		const target = path.join(tempDir, "new.txt");

		await new WriteTool(createSession(tempDir)).execute("write-new", {
			path: target,
			content: "new\nvalue\n",
		});

		expect(await Bun.file(target).text()).toBe("new\nvalue\n");
	});
});
