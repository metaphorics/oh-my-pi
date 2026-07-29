import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { getSessionsDir, parseJsonlLenient } from "@oh-my-pi/pi-utils";
import { HistoryStorage } from "../session/history-storage";
import { CURRENT_SESSION_VERSION, SESSION_TITLE_SLOT_BYTES } from "../session/session-entries";
import { parseTitleSlotLine } from "../session/session-title-slot";
import { assertInvariant, checkpointCandidate, stableJson, verifyCommonCandidate } from "./storage-repair-files";
import type { HistoryRepairSource, StorageRepairObjectResult, StorageRepairTestHooks } from "./storage-repair-types";

const COPY_BUFFER_BYTES = 1024 * 1024;
const ROW_BATCH_SIZE = 256;

interface SessionFileManifest {
	path: string;
	canonicalPath: string;
	dev: string;
	ino: string;
	size: number;
	mtimeNs: string;
	ctimeNs: string;
	sha256: string;
}

interface PromptRow {
	entry_ms: bigint;
	canonical_path: string;
	ordinal: bigint;
	prompt: string;
	cwd: string;
	session_id: string;
}

export interface PromptManifest {
	db: Database;
	path: string;
	count: number;
	root: string;
	fingerprint: string;
}

function codeOf(error: unknown) {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

async function sessionFiles(root: string) {
	let projects: fs.Dirent[];
	try {
		projects = await fs.promises.readdir(root, { withFileTypes: true });
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw error;
	}
	const result: string[] = [];
	for (const project of projects) {
		const projectPath = path.join(root, project.name);
		assertInvariant(!project.isSymbolicLink(), `Session manifest refuses symbolic link: ${projectPath}`);
		if (!project.isDirectory()) continue;
		for (const file of await fs.promises.readdir(projectPath, { withFileTypes: true })) {
			const filePath = path.join(projectPath, file.name);
			assertInvariant(!file.isSymbolicLink(), `Session manifest refuses symbolic link: ${filePath}`);
			if (file.isFile() && file.name.endsWith(".jsonl")) result.push(filePath);
		}
	}
	return result.sort();
}

async function hashSession(file: string) {
	const handle = await fs.promises.open(file, "r");
	const hash = new Bun.SHA256();
	const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
	let position = 0;
	try {
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
			if (bytesRead === 0) return { sha256: hash.digest("hex"), size: position };
			hash.update(buffer.subarray(0, bytesRead));
			position += bytesRead;
		}
	} finally {
		await handle.close();
	}
}

async function manifestSessions(root: string) {
	const manifests: SessionFileManifest[] = [];
	for (const file of await sessionFiles(root)) {
		const stat = await fs.promises.lstat(file, { bigint: true });
		assertInvariant(stat.isFile() && !stat.isSymbolicLink(), `Session is not a regular file: ${file}`);
		const canonicalPath = await fs.promises.realpath(file);
		const digest = await hashSession(file);
		assertInvariant(BigInt(digest.size) === stat.size, `Session changed while hashing: ${file}`);
		manifests.push({
			path: file,
			canonicalPath,
			dev: stat.dev.toString(),
			ino: stat.ino.toString(),
			size: digest.size,
			mtimeNs: stat.mtimeNs.toString(),
			ctimeNs: stat.ctimeNs.toString(),
			sha256: digest.sha256,
		});
	}
	return manifests.sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));
}

function parseJsonRecord(line: string, file: string, ordinal: number) {
	const [value] = parseJsonlLenient<unknown>(`${line}\n`);
	if (value === undefined) return null;
	assertInvariant(
		typeof value === "object" && value !== null && !Array.isArray(value),
		`Invalid JSONL record ${ordinal} in ${file}`,
	);
	return value as Record<string, unknown>;
}

function parsedTimestamp(value: unknown, label: string) {
	assertInvariant(typeof value === "string", `Missing timestamp in ${label}`);
	const parsed = Date.parse(value);
	assertInvariant(Number.isFinite(parsed), `Invalid timestamp in ${label}: ${value}`);
	return parsed;
}

function promptContent(content: unknown, label: string) {
	if (typeof content === "string") return content;
	assertInvariant(Array.isArray(content), `Invalid user message content in ${label}`);
	let text = "";
	for (const block of content) {
		assertInvariant(
			typeof block === "object" && block !== null && !Array.isArray(block),
			`Invalid content block in ${label}`,
		);
		const record = block as Record<string, unknown>;
		if (record.type === "text") {
			assertInvariant(typeof record.text === "string", `Invalid text block in ${label}`);
			text += record.text;
		} else if (record.type === "image") {
			assertInvariant(
				typeof record.data === "string" && typeof record.mimeType === "string",
				`Invalid image block in ${label}`,
			);
		} else {
			throw new Error(`Unsupported content block in ${label}`);
		}
	}
	return text;
}

function validateHeader(record: Record<string, unknown>, file: string) {
	assertInvariant(record.type === "session", `Missing session header in ${file}`);
	assertInvariant(typeof record.id === "string" && record.id.length > 0, `Invalid session id in ${file}`);
	assertInvariant(typeof record.cwd === "string" && record.cwd.length > 0, `Invalid session cwd in ${file}`);
	const timestamp = parsedTimestamp(record.timestamp, `session header ${file}`);
	const parentSession = record.parentSession;
	assertInvariant(
		parentSession === undefined || (typeof parentSession === "string" && parentSession.length > 0),
		`Invalid parent session in ${file}`,
	);
	const version = record.version ?? 1;
	assertInvariant(
		typeof version === "number" && Number.isInteger(version) && version >= 1 && version <= CURRENT_SESSION_VERSION,
		`Unsupported session version in ${file}`,
	);
	return { id: record.id, cwd: record.cwd, timestamp, parentSession };
}

async function parseSession(file: SessionFileManifest, promptDb: Database) {
	const input = fs.createReadStream(file.path, { encoding: "utf8" });
	const lines = readline.createInterface({ input, crlfDelay: Infinity });
	const insertSession = promptDb.prepare(
		"INSERT INTO sessions(canonical_path, session_id, header_ms, parent_ref, family) VALUES (?, ?, ?, ?, ?)",
	);
	const insert = promptDb.prepare(
		"INSERT INTO prompts(entry_ms, canonical_path, ordinal, entry_id, prompt, cwd, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	let physicalLine = 0;
	let recordOrdinal = 0;
	let header: { id: string; cwd: string; timestamp: number; parentSession: string | undefined } | null = null;
	let inserted = 0;
	promptDb.exec("BEGIN");
	try {
		for await (const line of lines) {
			physicalLine += 1;
			if (physicalLine === 1 && Buffer.byteLength(`${line}\n`, "utf8") === SESSION_TITLE_SLOT_BYTES) {
				if (parseTitleSlotLine(line)) continue;
			}
			const record = parseJsonRecord(line, file.path, physicalLine);
			if (!record) continue;
			if (!header) {
				header = validateHeader(record, file.path);
				insertSession.run(
					file.canonicalPath,
					header.id,
					BigInt(header.timestamp),
					header.parentSession ?? null,
					file.canonicalPath,
				);
				continue;
			}
			recordOrdinal += 1;
			assertInvariant(
				typeof record.id === "string" && record.id.length > 0,
				`Invalid record id in ${file.path}:${physicalLine}`,
			);
			const outerTimestamp = parsedTimestamp(record.timestamp, `record ${physicalLine} in ${file.path}`);
			if (record.type !== "message") continue;
			const message = record.message;
			assertInvariant(
				typeof message === "object" && message !== null && !Array.isArray(message),
				`Invalid message in ${file.path}:${physicalLine}`,
			);
			const typed = message as Record<string, unknown>;
			if (typed.role !== "user" || typed.attribution === "agent" || typed.synthetic === true) {
				continue;
			}
			const prompt = promptContent(typed.content, `${file.path}:${physicalLine}`).trim();
			if (prompt.length === 0) continue;
			const innerTimestamp = typed.timestamp;
			const timestamp =
				typeof innerTimestamp === "number" && Number.isFinite(innerTimestamp)
					? Math.trunc(innerTimestamp)
					: outerTimestamp;
			insert.run(
				BigInt(timestamp),
				file.canonicalPath,
				BigInt(recordOrdinal),
				record.id,
				prompt,
				header.cwd,
				header.id,
			);
			inserted += 1;
		}
		assertInvariant(physicalLine >= 1 && header, `Incomplete session file: ${file.path}`);
		promptDb.exec("COMMIT");
		return inserted;
	} catch (error) {
		try {
			promptDb.exec("ROLLBACK");
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], `Prompt manifest rollback failed for ${file.path}`);
		}
		throw error;
	} finally {
		insertSession.finalize();
		insert.finalize();
		lines.close();
		input.destroy();
	}
}

function deriveSessionFamilies(db: Database) {
	db.exec(`
		WITH RECURSIVE
			edges(source, target) AS (
				SELECT child.canonical_path, parent.canonical_path
				FROM sessions AS child
				JOIN sessions AS parent
					ON child.parent_ref = parent.session_id OR child.parent_ref = parent.canonical_path
				UNION
				SELECT child.canonical_path, 'missing:' || hex(child.parent_ref)
				FROM sessions AS child
				WHERE child.parent_ref IS NOT NULL
					AND NOT EXISTS (
						SELECT 1 FROM sessions AS parent
						WHERE child.parent_ref = parent.session_id OR child.parent_ref = parent.canonical_path
					)
			),
			nodes(node) AS (
				SELECT canonical_path FROM sessions
				UNION
				SELECT source FROM edges
				UNION
				SELECT target FROM edges
			),
			reachable(start, node) AS (
				SELECT node, node FROM nodes
				UNION
				SELECT reachable.start, edges.target
				FROM reachable JOIN edges ON edges.source = reachable.node
				UNION
				SELECT reachable.start, edges.source
				FROM reachable JOIN edges ON edges.target = reachable.node
			)
		UPDATE sessions
		SET family = (SELECT MIN(start) FROM reachable WHERE node = sessions.canonical_path)
	`);
}

export async function freezePromptManifest(
	tempDir: string,
	agentDir: string,
	hook?: StorageRepairTestHooks["afterSessionManifestParse"],
): Promise<PromptManifest> {
	const root = getSessionsDir(agentDir);
	const first = await manifestSessions(root);
	const dbPath = path.join(tempDir, "prompts.sqlite");
	const db = new Database(dbPath, { safeIntegers: true });
	db.exec(
		"CREATE TABLE sessions(canonical_path TEXT PRIMARY KEY, session_id TEXT NOT NULL, header_ms INTEGER NOT NULL, parent_ref TEXT, family TEXT NOT NULL); CREATE TABLE prompts(entry_ms INTEGER NOT NULL, canonical_path TEXT NOT NULL REFERENCES sessions(canonical_path), ordinal INTEGER NOT NULL, entry_id TEXT NOT NULL, prompt TEXT NOT NULL, cwd TEXT NOT NULL, session_id TEXT NOT NULL); CREATE INDEX prompts_family_entry_idx ON prompts(canonical_path, entry_id, entry_ms, prompt); CREATE INDEX sessions_parent_ref_idx ON sessions(parent_ref); CREATE INDEX sessions_id_idx ON sessions(session_id)",
	);
	const fingerprint = stableJson(first);
	let count = 0;
	try {
		for (const file of first) count += await parseSession(file, db);
		deriveSessionFamilies(db);
		await hook?.();
		assertInvariant(
			fingerprint === stableJson(await manifestSessions(root)),
			"Session directory changed while rebuilding history manifest",
		);
		return { db, path: dbPath, count, root, fingerprint };
	} catch (error) {
		db.close();
		throw error;
	}
}

export async function promptManifestStillMatches(manifest: PromptManifest | null): Promise<void> {
	assertInvariant(manifest, "Missing frozen session manifest");
	assertInvariant(
		manifest.fingerprint === stableJson(await manifestSessions(manifest.root)),
		"Session directory changed during storage repair",
	);
}

function sortedPrompts(manifest: Database) {
	return manifest
		.prepare(
			`SELECT entry_ms, canonical_path, ordinal, prompt, cwd, session_id
			 FROM (
				SELECT prompts.entry_ms, prompts.canonical_path, prompts.ordinal, prompts.prompt, prompts.cwd, prompts.session_id,
					ROW_NUMBER() OVER (
						PARTITION BY sessions.family, prompts.entry_id, prompts.entry_ms, prompts.prompt
						ORDER BY sessions.header_ms ASC, prompts.canonical_path ASC, prompts.ordinal ASC
					) AS fork_rank
				FROM prompts JOIN sessions ON sessions.canonical_path = prompts.canonical_path
			 )
			 WHERE fork_rank = 1
			 ORDER BY entry_ms ASC, canonical_path ASC, ordinal ASC`,
		)
		.iterate() as Iterable<PromptRow>;
}

export function buildHistoryCandidate(
	candidate: string,
	source: HistoryRepairSource,
	manifest: PromptManifest | null,
): StorageRepairObjectResult[] {
	HistoryStorage.initializeExactPath(candidate);
	const db = new Database(candidate, { safeIntegers: true });
	let inserted = 0;
	try {
		db.exec("DELETE FROM history");
		if (source === "sessions") inserted = insertPrompts(db, manifest);
		db.exec("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
	} finally {
		db.close();
	}
	return [
		{
			name: "history",
			kind: "table",
			owner: "history",
			action: "rebuilt",
			detail: `${inserted} rows`,
		},
		{ name: "idx_history_created_at", kind: "index", owner: "history", action: "rebuilt" },
		{ name: "history_fts", kind: "virtual table", owner: "history", action: "rebuilt" },
		{ name: "history_ai", kind: "trigger", owner: "history", action: "rebuilt" },
	];
}

function insertPrompts(db: Database, manifest: PromptManifest | null) {
	assertInvariant(manifest, "Missing frozen session manifest");
	const insert = db.prepare("INSERT INTO history(prompt, created_at, cwd, session_id) VALUES (?, ?, ?, ?)");
	const flush = db.transaction((rows: PromptRow[]) => {
		for (const row of rows) insert.run(row.prompt, row.entry_ms / 1000n, row.cwd, row.session_id);
	});
	let batch: PromptRow[] = [];
	let previous: string | null = null;
	let inserted = 0;
	try {
		for (const row of sortedPrompts(manifest.db)) {
			if (row.prompt === previous) continue;
			previous = row.prompt;
			batch.push(row);
			if (batch.length < ROW_BATCH_SIZE) continue;
			flush(batch);
			inserted += batch.length;
			batch = [];
		}
		if (batch.length > 0) {
			flush(batch);
			inserted += batch.length;
		}
		return inserted;
	} finally {
		insert.finalize();
	}
}

function verifyRows(candidate: Database, manifest: PromptManifest | null, source: HistoryRepairSource) {
	const actual = candidate
		.prepare("SELECT id, prompt, created_at, cwd, session_id FROM history ORDER BY id ASC")
		.iterate() as Iterable<Record<string, unknown>>;
	const iterator = actual[Symbol.iterator]();
	if (source === "fresh") {
		assertInvariant(iterator.next().done === true, "Fresh history candidate is not empty");
		return;
	}
	assertInvariant(manifest, "Missing prompt manifest during history verification");
	let expectedId = 0n;
	let previous: string | null = null;
	for (const row of sortedPrompts(manifest.db)) {
		if (row.prompt === previous) continue;
		previous = row.prompt;
		expectedId += 1n;
		const next = iterator.next();
		assertInvariant(!next.done, `History candidate is missing expected row ${expectedId}`);
		const value = next.value;
		assertInvariant(
			value.id === expectedId &&
				value.prompt === row.prompt &&
				value.created_at === row.entry_ms / 1000n &&
				value.cwd === row.cwd &&
				value.session_id === row.session_id,
			`History candidate row ${expectedId} differs from frozen manifest`,
		);
	}
	assertInvariant(iterator.next().done === true, "History candidate has unexpected extra rows");
}

export function verifyHistoryCandidate(
	candidate: string,
	source: HistoryRepairSource,
	manifest: PromptManifest | null,
) {
	HistoryStorage.validateExactPath(candidate);
	checkpointCandidate(candidate);
	const db = new Database(candidate, { safeIntegers: true });
	try {
		verifyRows(db, manifest, source);
		db.exec("INSERT INTO history_fts(history_fts, rank) VALUES('integrity-check', 1)");
	} finally {
		db.close();
	}
	checkpointCandidate(candidate);
	verifyCommonCandidate(candidate);
}

export function closePromptManifest(manifest: PromptManifest | null) {
	manifest?.db.close();
}
