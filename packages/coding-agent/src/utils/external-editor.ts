/**
 * Utilities for launching an external text editor ($VISUAL / $EDITOR).
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env, Snowflake } from "@oh-my-pi/pi-utils";

export function tokenizeEditorCommand(command: string): string[] {
	const isWindows = process.platform === "win32";
	const tokens: string[] = [];
	let token = "";
	let inSingle = false;
	let inDouble = false;

	const pushToken = () => {
		if (token.length > 0) {
			tokens.push(token);
			token = "";
		}
	};

	for (let i = 0; i < command.length; i++) {
		const character = command[i];
		if (inSingle) {
			if (character === "'") inSingle = false;
			else token += character;
			continue;
		}
		if (inDouble) {
			if (character === '"') {
				inDouble = false;
			} else if (!isWindows && character === "\\" && i + 1 < command.length && command[i + 1] === '"') {
				token += '"';
				i++;
			} else {
				token += character;
			}
			continue;
		}
		if (!isWindows && character === "'") {
			inSingle = true;
		} else if (character === '"') {
			inDouble = true;
		} else if (!isWindows && character === "\\" && i + 1 < command.length) {
			token += command[++i];
		} else if (character === " " || character === "\t") {
			pushToken();
		} else {
			token += character;
		}
	}

	if (inSingle || inDouble) throw new Error("Editor command has an unterminated quote");
	pushToken();
	return tokens;
}

function quoteWindowsShellArgument(argument: string): string {
	return `"${argument.replaceAll('"', '\\"')}"`;
}

/**
 * Returns the user's preferred editor command, or a platform default.
 *
 * Resolution order:
 *   1. `$VISUAL`
 *   2. `$EDITOR`
 *   3. `notepad` on Windows (always present in `%SystemRoot%\System32`)
 *
 * POSIX returns `undefined` when neither variable is set so the caller can
 * surface a warning that nudges the user to configure one.
 */
export function getEditorCommand(): string | undefined {
	const configured = $env.VISUAL?.trim() || $env.EDITOR?.trim();
	if (configured) return configured;
	if (process.platform === "win32") return "notepad";
	return undefined;
}

export interface OpenInEditorOptions {
	/** File extension for the temp file (default: ".md"). */
	extension?: string;
	/** Custom stdio configuration (default: all "inherit"). */
	stdio?: [number | "inherit", number | "inherit", number | "inherit"];
	/** Keep the file's trailing newline instead of trimming it from the returned text. */
	trimTrailingNewline?: boolean;
}

/**
 * Opens `content` in the user's external editor and returns the edited text.
 * Returns `null` if the editor exits with a non-zero code.
 *
 * The caller is responsible for stopping/starting the TUI around this call.
 */
export async function openInEditor(
	editorCmd: string,
	content: string,
	options?: OpenInEditorOptions,
): Promise<string | null> {
	const ext = options?.extension ?? ".md";
	const tmpFile = path.join(os.tmpdir(), `omp-editor-${Snowflake.next()}${ext}`);

	try {
		await Bun.write(tmpFile, content);

		const [editor, ...editorArgs] = tokenizeEditorCommand(editorCmd);
		if (!editor) throw new Error("Editor command is empty");
		const stdio = options?.stdio ?? ["inherit", "inherit", "inherit"];
		const commandArgs = [...editorArgs, tmpFile];
		const spawnArgs = process.platform === "win32" ? commandArgs.map(quoteWindowsShellArgument) : commandArgs;

		const child = spawn(process.platform === "win32" ? quoteWindowsShellArgument(editor) : editor, spawnArgs, {
			stdio,
			shell: process.platform === "win32",
		});
		const { promise, reject, resolve } = Promise.withResolvers<number>();
		child.once("exit", (code, signal) => resolve(code ?? (signal ? -1 : 0)));
		child.once("error", error => reject(error));
		const exitCode = await promise;

		if (exitCode === 0) {
			const text = await Bun.file(tmpFile).text();
			if (options?.trimTrailingNewline === false) {
				return text;
			}
			return text.replace(/\r?\n$/, "");
		}
		return null;
	} finally {
		try {
			await fs.rm(tmpFile, { force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}
