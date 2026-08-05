import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getEditorCommand, openInEditor, tokenizeEditorCommand } from "../src/utils/external-editor";

interface MutableProcess {
	platform: NodeJS.Platform;
}

function setPlatform(value: NodeJS.Platform): void {
	(process as unknown as MutableProcess).platform = value;
}

describe("getEditorCommand", () => {
	const originalPlatform = process.platform;
	const originalVisual = Bun.env.VISUAL;
	const originalEditor = Bun.env.EDITOR;

	afterEach(() => {
		setPlatform(originalPlatform);
		if (originalVisual === undefined) delete Bun.env.VISUAL;
		else Bun.env.VISUAL = originalVisual;
		if (originalEditor === undefined) delete Bun.env.EDITOR;
		else Bun.env.EDITOR = originalEditor;
	});

	it("prefers $VISUAL over $EDITOR and the platform default", () => {
		Bun.env.VISUAL = "nvim";
		Bun.env.EDITOR = "nano";
		setPlatform("win32");
		expect(getEditorCommand()).toBe("nvim");
	});

	it("falls back to $EDITOR when $VISUAL is unset", () => {
		delete Bun.env.VISUAL;
		Bun.env.EDITOR = "nano";
		expect(getEditorCommand()).toBe("nano");
	});

	it("trims whitespace so an accidentally padded value still works", () => {
		Bun.env.VISUAL = "  code --wait  ";
		delete Bun.env.EDITOR;
		expect(getEditorCommand()).toBe("code --wait");
	});

	it("treats a whitespace-only $VISUAL as unset and consults $EDITOR", () => {
		Bun.env.VISUAL = "   ";
		Bun.env.EDITOR = "vim";
		expect(getEditorCommand()).toBe("vim");
	});

	it("defaults to notepad on Windows when neither variable is set", () => {
		delete Bun.env.VISUAL;
		delete Bun.env.EDITOR;
		setPlatform("win32");
		expect(getEditorCommand()).toBe("notepad");
	});

	it("returns undefined on POSIX when neither variable is set", () => {
		delete Bun.env.VISUAL;
		delete Bun.env.EDITOR;
		setPlatform("linux");
		expect(getEditorCommand()).toBeUndefined();
	});

	describe("tokenizeEditorCommand", () => {
		it("keeps Windows backslashes literal in bare and quoted paths", () => {
			setPlatform("win32");
			expect(tokenizeEditorCommand(String.raw`C:\tools\vim.exe`)).toEqual([String.raw`C:\tools\vim.exe`]);
			expect(tokenizeEditorCommand(String.raw`"C:\Program Files\x\ed.exe" --wait`)).toEqual([
				String.raw`C:\Program Files\x\ed.exe`,
				"--wait",
			]);
		});

		it("keeps POSIX quoting and backslash escaping", () => {
			setPlatform("linux");
			expect(tokenizeEditorCommand('"/opt/my editor/bin/edit" --wait')).toEqual([
				"/opt/my editor/bin/edit",
				"--wait",
			]);
			expect(tokenizeEditorCommand(String.raw`editor --label=my\ editor`)).toEqual(["editor", "--label=my editor"]);
		});
	});

	it("preserves spaced editor and temp-file paths and trims CRLF output", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp editor test-"));
		const editorPath = path.join(tempDir, process.platform === "win32" ? "editor.cmd" : "editor.sh");
		const script =
			process.platform === "win32"
				? "@echo off\r\n(echo edited)>%1\r\n"
				: "#!/bin/sh\nprintf 'edited\\r\\n' > \"$1\"\n";
		await Bun.write(editorPath, script);
		if (process.platform !== "win32") await fs.chmod(editorPath, 0o755);
		const tmpdirSpy = spyOn(os, "tmpdir").mockReturnValue(tempDir);

		try {
			expect(await openInEditor(`"${editorPath}"`, "original", { trimTrailingNewline: true })).toBe("edited");
		} finally {
			tmpdirSpy.mockRestore();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
