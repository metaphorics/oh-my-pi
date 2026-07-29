import { Database, constants as sqliteConstants } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectGcErrors, runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { runStorageRepair, type StorageRepairResult } from "@oh-my-pi/pi-coding-agent/cli/storage-repair-cli";
import { resolveArtifactPaths } from "@oh-my-pi/pi-coding-agent/cli/storage-repair-files";
import { initializeMemoryStorageExactPath } from "@oh-my-pi/pi-coding-agent/memories/storage";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { getAgentDbPath, getHistoryDbPath, getSessionsDir } from "@oh-my-pi/pi-utils";

let root: string;
let stdout: string[];
let stdoutSpy: { mockRestore(): void } | undefined;

interface FileFingerprint {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
	mode: bigint;
	uid: bigint;
	gid: bigint;
	sha256: string;
}

type SessionFormat = "legacy-slotless" | "title-slot";

interface SessionHeaderOverrides {
	timestamp?: string;
	cwd?: string;
	parentSession?: string;
}

function requireValue<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`Missing ${label}`);
	return value;
}

function checksumPathCounts(result: StorageRepairResult): Record<string, number> {
	return Object.fromEntries(
		result.checksums.reduce((counts, checksum) => {
			counts.set(checksum.path, (counts.get(checksum.path) ?? 0) + 1);
			return counts;
		}, new Map<string, number>()),
	);
}

beforeEach(async () => {
	root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-storage-repair-test-"));
	stdout = [];
	stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
		stdout.push(String(chunk));
		return true;
	});
});

afterEach(async () => {
	stdoutSpy?.mockRestore();
	stdoutSpy = undefined;
	await fs.promises.rm(root, { recursive: true, force: true });
});

function closeWal(db: Database) {
	db.fileControl(sqliteConstants.SQLITE_FCNTL_PERSIST_WAL, 0);
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	db.close();
}

function closeWithPhysicalWal(db: Database) {
	db.fileControl(sqliteConstants.SQLITE_FCNTL_PERSIST_WAL, 1);
	db.close();
}

async function createAgentSource() {
	const dbPath = getAgentDbPath(root);
	AgentStorage.initializeExactPath(dbPath);
	initializeMemoryStorageExactPath(dbPath);
	const initialized = new Database(dbPath);
	closeWal(initialized);
	Bun.gc(true);
	const db = new Database(dbPath, { safeIntegers: true });
	db.prepare("INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)").run("theme", '"dark"', 11n);
	db.prepare("INSERT INTO model_usage(model_key, last_used_at) VALUES (?, ?)").run("openai/gpt", 12n);
	db.prepare("INSERT INTO clients(install_id, hostname, first_seen, last_seen) VALUES (?, ?, ?, ?)").run(
		"install-1",
		"host",
		13n,
		14n,
	);
	db.prepare("INSERT INTO threads(id, updated_at, rollout_path, cwd, source_kind) VALUES (?, ?, ?, ?, ?)").run(
		"thread-1",
		15n,
		"/tmp/rollout.jsonl",
		"/tmp",
		"session",
	);
	db.prepare(
		"INSERT INTO stage1_outputs(thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at) VALUES (?, ?, ?, ?, ?, ?)",
	).run("thread-1", 15n, "raw", "summary", null, 16n);
	db.exec("CREATE TABLE ext_notes(key TEXT PRIMARY KEY, large_int INTEGER, payload BLOB)");
	db.exec("CREATE INDEX ext_notes_large_int ON ext_notes(large_int)");
	db.exec("CREATE VIEW ext_notes_view AS SELECT key, large_int FROM ext_notes");
	db.exec("CREATE TRIGGER ext_notes_touch AFTER UPDATE ON ext_notes BEGIN SELECT NEW.key; END");
	db.exec(
		"CREATE TABLE shadowed_rowid(rowid TEXT, __omp_salvage_rowid_0 TEXT, __omp_salvage_rowid_1 TEXT, value TEXT)",
	);
	db.prepare(
		"INSERT INTO shadowed_rowid(_rowid_, rowid, __omp_salvage_rowid_0, __omp_salvage_rowid_1, value) VALUES (?, ?, ?, ?, ?)",
	).run(77n, "declared", "also-declared", "also-declared-2", "kept");
	db.exec("CREATE TABLE composite_pk(a INTEGER, b TEXT, PRIMARY KEY(a, b))");
	db.prepare("INSERT INTO composite_pk(rowid, a, b) VALUES (?, ?, ?)").run(88n, 1n, "b");
	db.exec("CREATE TABLE rowid_alias(id INTEGER PRIMARY KEY, value TEXT)");
	db.prepare("INSERT INTO rowid_alias(id, value) VALUES (?, ?)").run(89n, "alias");
	db.exec("CREATE TABLE integer_primary_key_desc(id INTEGER PRIMARY KEY DESC, value TEXT)");
	db.prepare("INSERT INTO integer_primary_key_desc(rowid, id, value) VALUES (?, ?, ?)").run(90n, 8n, "desc");
	db.exec("CREATE TABLE implicit_int_primary_key(id INT PRIMARY KEY, value TEXT)");
	db.prepare("INSERT INTO implicit_int_primary_key(rowid, id, value) VALUES (?, ?, ?)").run(91n, 9n, "int");
	db.prepare("INSERT INTO ext_notes(rowid, key, large_int, payload) VALUES (?, ?, ?, ?)").run(
		41n,
		"note",
		9_007_199_254_740_993n,
		new Uint8Array([0, 1, 255]),
	);
	closeWithPhysicalWal(db);
	Bun.gc(true);
	return dbPath;
}

async function createHistorySource() {
	const dbPath = getHistoryDbPath(root);
	HistoryStorage.initializeExactPath(dbPath);
	closeWal(new Database(dbPath));
	Bun.gc(true);
	return dbPath;
}

async function writeSession(
	project: string,
	name: string,
	records: Record<string, unknown>[],
	format: SessionFormat = "title-slot",
	headerOverrides: SessionHeaderOverrides = {},
) {
	const dir = path.join(getSessionsDir(root), project);
	await fs.promises.mkdir(dir, { recursive: true });
	const file = path.join(dir, `${name}.jsonl`);
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: name,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: `/work/${project}`,
		...headerOverrides,
	};
	const body = [
		...(format === "title-slot" ? [serializeTitleSlot({ title: name, updatedAt: header.timestamp })] : []),
		`${JSON.stringify(header)}\n`,
		...records.map(record => `${JSON.stringify(record)}\n`),
	].join("");
	await Bun.write(file, body);
	return file;
}

function message(id: string, timestamp: string, content: unknown, extra: Record<string, unknown> = {}) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: { role: "user", content, ...extra },
	};
}

async function fingerprint(file: string): Promise<FileFingerprint> {
	const stat = await fs.promises.lstat(file, { bigint: true });
	return {
		dev: stat.dev,
		ino: stat.ino,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
		ctimeNs: stat.ctimeNs,
		mode: stat.mode,
		uid: stat.uid,
		gid: stat.gid,
		sha256: new Bun.SHA256().update(await Bun.file(file).bytes()).digest("hex"),
	};
}

function sourceTripletPaths(dbPath: string) {
	return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`] as const;
}

async function fingerprintTriplet(dbPath: string) {
	return Promise.all(sourceTripletPaths(dbPath).map(fingerprint));
}

async function corruptTablePage(dbPath: string, table: string) {
	const db = new Database(dbPath, { readonly: true, safeIntegers: true });
	const pageSize = db.prepare("PRAGMA page_size").values()[0]?.[0];
	const row = db.prepare("SELECT rootpage FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as {
		rootpage?: bigint;
	} | null;
	db.close();
	if (typeof pageSize !== "bigint" || typeof row?.rootpage !== "bigint") throw new Error(`Cannot locate ${table}`);
	const handle = await fs.promises.open(dbPath, "r+");
	try {
		await handle.write(
			Buffer.alloc(Number(pageSize), 0xa5),
			0,
			Number(pageSize),
			Number((row.rootpage - 1n) * pageSize),
		);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function artifactModes(result: { backup: string; candidate: string }) {
	return Promise.all([fs.promises.stat(result.backup), fs.promises.stat(result.candidate)]).then(
		([backup, candidate]) => ({
			backup: backup.mode & 0o777,
			candidate: candidate.mode & 0o777,
		}),
	);
}

async function stageArtifacts(finalPath: string, label: "backup" | "candidate") {
	const prefix = `.${path.basename(finalPath)}.${label}-`;
	return (await fs.promises.readdir(path.dirname(finalPath))).filter(name => name.startsWith(prefix));
}

describe("offline SQLite salvage", () => {
	test("rejects normalized and mixed-case source-triplet artifact aliases on caseless platforms", async () => {
		const source = path.join(root, "agent.db");
		await fs.promises.writeFile(source, "source");

		for (const platform of ["darwin", "win32"] as const) {
			const options = { platform: () => platform };
			await expect(
				resolveArtifactPaths(source, path.join(root, "nested", "..", "agent.db"), options),
			).rejects.toThrow("Repair output already exists");
			for (const output of [
				path.join(root, "nested", "..", "agent.db-wal"),
				path.join(root, "nested", "..", "agent.db-shm"),
				path.join(root, "AGENT.DB-WAL"),
				path.join(root, "AGENT.DB-SHM"),
			]) {
				await expect(resolveArtifactPaths(source, output, options)).rejects.toThrow(
					"Repair artifact collides with source triplet",
				);
			}
		}
	});

	test("rejects a normalized candidate alias of the backup before publication", async () => {
		const source = path.join(root, "agent.db");
		const slug = "fixed";
		await fs.promises.writeFile(source, "source");

		for (const platform of ["darwin", "win32"] as const) {
			await expect(
				resolveArtifactPaths(source, path.join(root, "nested", "..", `agent.db.salvage-${slug}.tar`), {
					platform: () => platform,
					artifactSlug: () => slug,
				}),
			).rejects.toThrow("Candidate and backup paths collide");
		}
	});

	test("rejects Win32 trailing-dot and trailing-space source-triplet aliases", async () => {
		const source = path.join(root, "agent.db");
		await fs.promises.writeFile(source, "source");

		for (const output of [
			path.join(root, "AGENT.DB. "),
			path.join(root, "AGENT.DB-WAL. "),
			path.join(root, "AGENT.DB-SHM. "),
		]) {
			await expect(resolveArtifactPaths(source, output, { platform: () => "win32" })).rejects.toThrow(
				"Repair artifact collides with source triplet",
			);
		}
	});

	test("rejects a Win32 trailing-dot candidate alias of the backup", async () => {
		const source = path.join(root, "agent.db");
		const slug = "fixed";
		await fs.promises.writeFile(source, "source");

		await expect(
			resolveArtifactPaths(source, path.join(root, `agent.db.salvage-${slug}.tar. `), {
				platform: () => "win32",
				artifactSlug: () => slug,
			}),
		).rejects.toThrow("Candidate and backup paths collide");
	});

	test("rejects Win32 aliases in an existing intermediate parent component", async () => {
		const sourceParent = path.join(root, "artifacts");
		const aliasParent = `${sourceParent}. `;
		const source = path.join(sourceParent, "agent.db");
		const sourceSidecarAlias = path.join(aliasParent, "agent.db-wal");
		const slug = "fixed";
		const candidateBackupAlias = path.join(aliasParent, `agent.db.salvage-${slug}.tar`);
		await Promise.all([fs.promises.mkdir(sourceParent), fs.promises.mkdir(aliasParent)]);
		await fs.promises.writeFile(source, "source");

		await expect(resolveArtifactPaths(source, sourceSidecarAlias, { platform: () => "win32" })).rejects.toThrow(
			"Repair artifact collides with source triplet",
		);
		await expect(
			resolveArtifactPaths(source, candidateBackupAlias, {
				platform: () => "win32",
				artifactSlug: () => slug,
			}),
		).rejects.toThrow("Candidate and backup paths collide");

		for (const platform of ["darwin", "linux"] as const) {
			const sidecarArtifacts = await resolveArtifactPaths(source, sourceSidecarAlias, {
				platform: () => platform,
			});
			expect(sidecarArtifacts.candidate).toBe(sourceSidecarAlias);
			const backupArtifacts = await resolveArtifactPaths(source, candidateBackupAlias, {
				platform: () => platform,
				artifactSlug: () => slug,
			});
			expect(backupArtifacts.candidate).toBe(candidateBackupAlias);
		}
	});

	test("keeps trailing-dot and trailing-space artifact paths distinct on Darwin and Linux", async () => {
		const source = path.join(root, "agent.db");
		const output = path.join(root, "AGENT.DB-WAL. ");
		await fs.promises.writeFile(source, "source");

		for (const platform of ["darwin", "linux"] as const) {
			const artifacts = await resolveArtifactPaths(source, output, { platform: () => platform });
			expect(artifacts.candidate).toBe(output);
		}
	});

	test("rejects Unicode-normalized source-sidecar and candidate-backup aliases", async () => {
		const sourceName = "agent-é.db";
		const normalizedAlias = "agent-e\u0301.db";
		const source = path.join(root, sourceName);
		const alias = path.join(root, normalizedAlias);
		const slug = "fixed";
		await fs.promises.writeFile(source, "source");

		for (const platform of ["darwin", "win32"] as const) {
			await expect(resolveArtifactPaths(source, `${alias}-wal`, { platform: () => platform })).rejects.toThrow(
				"Repair artifact collides with source triplet",
			);
			await expect(
				resolveArtifactPaths(source, `${alias}.salvage-${slug}.tar`, {
					platform: () => platform,
					artifactSlug: () => slug,
				}),
			).rejects.toThrow("Candidate and backup paths collide");
		}
	});

	test("rejects full Unicode folds on caseless platforms but not Linux", async () => {
		const source = path.join(root, "agent-straße.db");
		const alias = path.join(root, "AGENT-STRASSE.DB");
		await fs.promises.writeFile(source, "source");

		for (const platform of ["darwin", "win32"] as const) {
			await expect(resolveArtifactPaths(source, `${alias}-shm`, { platform: () => platform })).rejects.toThrow(
				"Repair artifact collides with source triplet",
			);
		}
		const artifacts = await resolveArtifactPaths(source, `${alias}-shm`, { platform: () => "linux" });
		expect(artifacts.candidate).toBe(`${alias}-shm`);
	});

	test("accepts distinct repair artifact paths", async () => {
		const source = path.join(root, "agent.db");
		const candidate = path.join(root, "repaired.db");
		await fs.promises.writeFile(source, "source");

		const artifacts = await resolveArtifactPaths(source, candidate, { platform: () => "linux" });
		expect(artifacts.candidate).toBe(candidate);
		expect(artifacts.backup).not.toBe(candidate);
	});

	test("physical corruption fixture reproduces normal owner-open failure", async () => {
		const dbPath = await createAgentSource();
		closeWal(new Database(dbPath));
		const handle = await fs.promises.open(dbPath, "r+");
		try {
			await handle.write(Buffer.from("not sqlite"), 0, 10, 0);
		} finally {
			await handle.close();
		}
		expect(() => AgentStorage.validateExactPath(dbPath)).toThrow();
	});

	test("history rebuild salvages a source that SQLite cannot open", async () => {
		const dbPath = await createHistorySource();
		closeWal(new Database(dbPath));
		const handle = await fs.promises.open(dbPath, "r+");
		try {
			await handle.write(Buffer.from("not sqlite"), 0, 10, 0);
		} finally {
			await handle.close();
		}
		expect(() => HistoryStorage.validateExactPath(dbPath)).toThrow();
		const result = await runStorageRepair({
			target: "history",
			historySource: "fresh",
			apply: false,
			agentDir: root,
		});
		expect(result.status).toBe("ready");
		expect(result.dataLoss).toBe(true);
	});

	test("dry-run preserves bytes and identity metadata for every physical source triplet member", async () => {
		const dbPath = await createAgentSource();
		const before = await fingerprintTriplet(dbPath);
		const siblings = await fs.promises.readdir(path.dirname(dbPath));
		const result = await runStorageRepair({ target: "agent", apply: false, agentDir: root });
		expect(result.status).toBe("ready");
		expect(result.dataLoss).toBe(false);
		expect(result.backupCreated).toBe(false);
		expect(result.candidatePublished).toBe(false);
		expect(result.candidatePathTrusted).toBe(false);
		expect(await fingerprintTriplet(dbPath)).toEqual(before);
		expect(await fs.promises.readdir(path.dirname(dbPath))).toEqual(siblings);
	});

	test("a changed physical WAL refuses and leaves every source member at its post-change fingerprint", async () => {
		const dbPath = await createAgentSource();
		const before = await fingerprintTriplet(dbPath);
		let afterMutation = before;
		const result = await runStorageRepair(
			{ target: "agent", apply: false, agentDir: root },
			{
				afterPristineCopy: async () => {
					await fs.promises.appendFile(`${dbPath}-wal`, "source-sidecar-change");
					afterMutation = await fingerprintTriplet(dbPath);
				},
			},
		);
		expect(afterMutation[1]?.sha256).not.toBe(before[1]?.sha256);
		expect(result.status).toBe("refused");
		expect(result.refusal).toContain("Live source triplet changed");
		expect(await fingerprintTriplet(dbPath)).toEqual(afterMutation);
	});

	test("a structural refusal preserves bytes and identity metadata for every physical source triplet member", async () => {
		const dbPath = await createAgentSource();
		const db = new Database(dbPath);
		db.exec("ALTER TABLE settings ADD COLUMN drift TEXT");
		closeWithPhysicalWal(db);
		const before = await fingerprintTriplet(dbPath);
		const result = await runStorageRepair({ target: "agent", apply: false, agentDir: root });
		expect(result.status).toBe("refused");
		expect(result.refusal).toContain("Structural drift");
		expect(await fingerprintTriplet(dbPath)).toEqual(before);
	});

	test("a live triplet change during the stable copy window refuses without artifacts", async () => {
		const dbPath = await createAgentSource();
		const result = await runStorageRepair(
			{ target: "agent", apply: true, agentDir: root },
			{ afterPristineCopy: () => fs.promises.appendFile(dbPath, "race") },
		);
		expect(result.status).toBe("refused");
		expect(result.refusal).toContain("changed");
		expect(result.backupCreated).toBe(false);
		expect(result.candidatePublished).toBe(false);
		expect(result.candidatePathTrusted).toBe(false);
	});

	test("apply publishes verified raw tar first and a mode-0600 exact candidate", async () => {
		const dbPath = await createAgentSource();
		const sourceDigest = new Bun.SHA256().update(await Bun.file(dbPath).bytes()).digest("hex");
		const result = await runStorageRepair({ target: "agent", apply: true, agentDir: root });
		if (result.status !== "ready") throw new Error(result.refusal);
		expect(result.status).toBe("ready");
		expect(result.backupCreated).toBe(true);
		expect(result.candidatePublished).toBe(true);
		expect(result.candidatePathTrusted).toBe(true);
		expect(checksumPathCounts(result)).toEqual({ [result.backup]: 1, [result.candidate]: 1 });
		expect(await artifactModes(result)).toEqual({ backup: 0o600, candidate: 0o600 });
		const archive = new Bun.Archive(await Bun.file(result.backup).bytes());
		const files = await archive.files();
		const main = files.get(`source/${path.basename(dbPath)}`);
		if (!main) throw new Error("Backup main member is missing");
		expect(new Bun.SHA256().update(await main.bytes()).digest("hex")).toBe(sourceDigest);
		expect(JSON.parse((await files.get("manifest.json")?.text()) ?? "{}").formatVersion).toBe(1);
	});

	test("agent candidate preserves authoritative storage classes and a simple extension closure", async () => {
		await createAgentSource();
		const result = await runStorageRepair({ target: "agent", apply: true, agentDir: root });
		expect(result.status).toBe("ready");
		const db = new Database(result.candidate, { readonly: true, safeIntegers: true });
		try {
			expect(db.prepare("SELECT value FROM settings WHERE key = ?").get("theme")).toEqual({ value: '"dark"' });
			expect(db.prepare("SELECT rowid, large_int, payload FROM ext_notes WHERE key = ?").get("note")).toEqual({
				rowid: 41n,
				large_int: 9_007_199_254_740_993n,
				payload: new Uint8Array([0, 1, 255]),
			});
			expect(
				db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?").get("ext_notes_large_int"),
			).toBeDefined();
			expect(
				db
					.prepare(
						"SELECT _rowid_ AS implicit_rowid, rowid, __omp_salvage_rowid_0, __omp_salvage_rowid_1, value FROM shadowed_rowid",
					)
					.get(),
			).toEqual({
				implicit_rowid: 77n,
				rowid: "declared",
				__omp_salvage_rowid_0: "also-declared",
				__omp_salvage_rowid_1: "also-declared-2",
				value: "kept",
			});
			expect(db.prepare("SELECT rowid, a, b FROM composite_pk").get()).toEqual({ rowid: 88n, a: 1n, b: "b" });
			expect(db.prepare("SELECT rowid AS implicit_rowid, id, value FROM rowid_alias").get()).toEqual({
				implicit_rowid: 89n,
				id: 89n,
				value: "alias",
			});
			expect(db.prepare("SELECT rowid, id, value FROM integer_primary_key_desc").get()).toEqual({
				rowid: 90n,
				id: 8n,
				value: "desc",
			});
			expect(db.prepare("SELECT rowid, id, value FROM implicit_int_primary_key").get()).toEqual({
				rowid: 91n,
				id: 9n,
				value: "int",
			});
			expect(db.prepare("SELECT key, large_int FROM ext_notes_view").get()).toEqual({
				key: "note",
				large_int: 9_007_199_254_740_993n,
			});
		} finally {
			db.close();
		}
		expect(result.objects).toContainEqual(expect.objectContaining({ name: "settings", action: "preserved" }));
		expect(result.objects).toContainEqual(expect.objectContaining({ name: "ext_notes", action: "preserved" }));
		expect(result.objects).toContainEqual(expect.objectContaining({ name: "ext_notes_view", action: "preserved" }));
		expect(result.objects).toContainEqual(expect.objectContaining({ name: "ext_notes_touch", action: "preserved" }));
	});

	test("pre-verification built-in row rewrites and deletions refuse the candidate", async () => {
		const dbPath = await createAgentSource();
		const sourceBefore = await fingerprintTriplet(dbPath);
		for (const [kind, mutate, expectedRefusal] of [
			[
				"rewrite",
				(db: Database) => db.prepare("UPDATE settings SET value = ? WHERE key = ?").run('"light"', "theme"),
				"Candidate row value mismatch in settings.value",
			],
			[
				"deletion",
				(db: Database) => db.prepare("DELETE FROM settings WHERE key = ?").run("theme"),
				"Candidate row count mismatch in settings",
			],
		] as const) {
			const candidate = path.join(root, `candidate-built-in-${kind}.db`);
			const result = await runStorageRepair(
				{ target: "agent", apply: true, agentDir: root, output: candidate },
				{
					beforeCandidateVerification: async () => {
						const stage = requireValue(
							(await stageArtifacts(candidate, "candidate")).find(name => name.endsWith(".tmp")),
							"candidate database stage",
						);
						const stagedDb = new Database(path.join(root, stage), { safeIntegers: true });
						try {
							mutate(stagedDb);
						} finally {
							closeWal(stagedDb);
						}
					},
				},
			);
			expect(result.status).toBe("refused");
			expect(result.refusal).toContain(expectedRefusal);
			expect(result.candidatePublished).toBe(false);
			expect(await Bun.file(candidate).exists()).toBe(false);
			expect(await stageArtifacts(candidate, "candidate")).toEqual([]);
			expect(await fingerprintTriplet(dbPath)).toEqual(sourceBefore);
		}
	});

	test("pre-verification extension BLOB mutation refuses the candidate", async () => {
		const dbPath = await createAgentSource();
		const sourceBefore = await fingerprintTriplet(dbPath);
		const candidate = path.join(root, "candidate-extension-row.db");
		const result = await runStorageRepair(
			{ target: "agent", apply: true, agentDir: root, output: candidate },
			{
				beforeCandidateVerification: async () => {
					const stage = requireValue(
						(await stageArtifacts(candidate, "candidate")).find(name => name.endsWith(".tmp")),
						"candidate database stage",
					);
					const stagedDb = new Database(path.join(root, stage), { safeIntegers: true });
					try {
						stagedDb
							.prepare("UPDATE ext_notes SET payload = ? WHERE key = ?")
							.run(new Uint8Array([255, 1, 0]), "note");
					} finally {
						closeWal(stagedDb);
					}
				},
			},
		);
		expect(result.status).toBe("refused");
		expect(result.refusal).toContain("Candidate row value mismatch in ext_notes.payload");
		expect(result.candidatePublished).toBe(false);
		expect(await Bun.file(candidate).exists()).toBe(false);
		expect(await stageArtifacts(candidate, "candidate")).toEqual([]);
		expect(await fingerprintTriplet(dbPath)).toEqual(sourceBefore);
	});

	test("agent repair preserves AUTOINCREMENT high-water marks after the highest row is deleted", async () => {
		const dbPath = await createAgentSource();
		const source = new Database(dbPath, { safeIntegers: true });
		source.exec("CREATE TABLE ext_autoincrement(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)");
		const insert = source.prepare("INSERT INTO ext_autoincrement(value) VALUES (?)");
		insert.run("first");
		insert.run("second");
		insert.run("deleted-high-water");
		insert.finalize();
		source.exec("DELETE FROM ext_autoincrement WHERE id = 3");
		closeWithPhysicalWal(source);

		const result = await runStorageRepair({ target: "agent", apply: true, agentDir: root });
		expect(result.status).toBe("ready");
		const candidate = new Database(result.candidate, { safeIntegers: true });
		try {
			expect(candidate.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get("ext_autoincrement")).toEqual({
				seq: 3n,
			});
			candidate.prepare("INSERT INTO ext_autoincrement(value) VALUES (?)").run("next");
			expect(candidate.prepare("SELECT id FROM ext_autoincrement WHERE value = ?").get("next")).toEqual({ id: 4n });
		} finally {
			candidate.close();
		}
	});

	test("only a registered corrupt derived table may be omitted", async () => {
		const dbPath = await createAgentSource();
		const db = new Database(dbPath);
		db.prepare("INSERT INTO cache(key, value, expires_at) VALUES (?, ?, ?)").run("broken", "value", 1);
		closeWal(db);
		await corruptTablePage(dbPath, "cache");
		const result = await runStorageRepair({ target: "agent", apply: false, agentDir: root });
		expect(result.status).toBe("ready");
		expect(result.dataLoss).toBe(true);
		expect(result.objects).toContainEqual(expect.objectContaining({ name: "cache", action: "omitted" }));

		const gcResult = await runGcCommand({ flags: { agentDir: root, repairStorage: "agent" } });
		expect(gcResult.repair?.dataLoss).toBe(true);
		expect(stdout.join("")).toContain("registered rebuildable tables omitted: cache");
	});

	test("authoritative page corruption refuses with the SQLite cause", async () => {
		const dbPath = await createAgentSource();
		closeWal(new Database(dbPath));
		await corruptTablePage(dbPath, "settings");
		const result = await runStorageRepair({ target: "agent", apply: false, agentDir: root });
		expect(result.status).toBe("refused");
		expect(result.refusal).toContain("database disk image is malformed");
	});

	test("refusal before candidate retains diagnosed omitted tables in result, JSON, and text", async () => {
		const dbPath = await createAgentSource();
		const db = new Database(dbPath);
		db.prepare("INSERT INTO cache(key, value, expires_at) VALUES (?, ?, ?)").run("broken", "value", 1);
		closeWal(db);
		await corruptTablePage(dbPath, "cache");

		const originalOpen = fs.promises.open;
		const openSpy = spyOn(fs.promises, "open").mockImplementation(async (file, flags, mode) => {
			if (typeof file === "string" && file.includes(".backup-") && file.endsWith(".tmp")) {
				throw new Error("backup injection");
			}
			return originalOpen(file, flags, mode);
		});
		try {
			const jsonResult = await runGcCommand({
				flags: { agentDir: root, repairStorage: "agent", apply: true, json: true },
			});
			expect(jsonResult.repair).toMatchObject({
				status: "refused",
				dataLoss: true,
				diagnosedOmittedTables: ["cache"],
			});
			expect(JSON.parse(stdout.join("")).repair.diagnosedOmittedTables).toEqual(["cache"]);

			stdout = [];
			const textResult = await runGcCommand({ flags: { agentDir: root, repairStorage: "agent", apply: true } });
			expect(textResult.repair?.diagnosedOmittedTables).toEqual(["cache"]);
			expect(stdout.join("")).toContain("registered rebuildable tables omitted: cache");
			expect(stdout.join("")).not.toContain("fresh empty history");
		} finally {
			openSpy.mockRestore();
		}
	});

	test("an impossible snapshot transition reports both rollback failures", async () => {
		await createAgentSource();
		const originalExec = Database.prototype.exec;
		let rollbackAttempts = 0;
		const execSpy = spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql: string) {
			if (sql !== "ROLLBACK") return originalExec.call(this, sql);
			rollbackAttempts++;
			throw new Error(rollbackAttempts === 1 ? "snapshot release failed" : "snapshot cleanup failed");
		});
		try {
			const result = await runStorageRepair({ target: "agent", apply: false, agentDir: root });
			expect(result.status).toBe("refused");
			expect(result.refusal).toBe(
				"Working SQLite snapshot failed and rollback also failed: snapshot release failed; snapshot cleanup failed",
			);
		} finally {
			execSpy.mockRestore();
		}
	});

	test("core schema drift and unsafe extension constraints refuse", async () => {
		const dbPath = await createAgentSource();
		let db = new Database(dbPath);
		db.exec("ALTER TABLE settings ADD COLUMN drift TEXT");
		closeWal(db);
		let result = await runStorageRepair({ target: "agent", apply: false, agentDir: root });
		expect(result.status).toBe("refused");
		expect(result.refusal).toContain("Structural drift");

		await fs.promises.rm(dbPath, { force: true });
		await fs.promises.rm(`${dbPath}-wal`, { force: true });
		await fs.promises.rm(`${dbPath}-shm`, { force: true });
		await createAgentSource();
		db = new Database(dbPath);
		db.exec("CREATE TABLE unsafe_extension(value TEXT CHECK(length(value) > 0))");
		closeWal(db);
		result = await runStorageRepair({ target: "agent", apply: false, agentDir: root });
		expect(result.status).toBe("refused");
		expect(result.refusal).toContain("Unsafe extension table shape");
	});

	test("sessions rebuild uses strict global ordering, adjacent deduplication, and FTS rank-1 integrity", async () => {
		await createHistorySource();
		await writeSession("b", "session-b", [
			message("b1", "2026-01-01T00:00:03.900Z", "third prompt"),
			message("b2", "2026-01-01T00:00:04.000Z", "user steering", { steering: true, attribution: "user" }),
			message("b3", "2026-01-01T00:00:04.100Z", "agent steering", { steering: true, attribution: "agent" }),
		]);
		await writeSession("a", "session-a", [
			message("a1", "2026-01-01T00:00:01.900Z", [
				{ type: "text", text: "first " },
				{ type: "image", data: "x", mimeType: "image/png" },
				{ type: "text", text: "prompt" },
			]),
			message("a2", "2026-01-01T00:00:02.900Z", "first prompt"),
			message("a3", "2026-01-01T00:00:03.100Z", "agent note", { attribution: "agent" }),
		]);
		const result = await runStorageRepair({
			target: "history",
			historySource: "sessions",
			apply: true,
			agentDir: root,
		});
		expect(result.status).toBe("ready");
		expect(result.dataLoss).toBe(true);
		expect(result.objects.find(object => object.name === "history")).toMatchObject({ action: "rebuilt" });
		const db = new Database(result.candidate, { readonly: true, safeIntegers: true });
		try {
			expect(db.prepare("SELECT prompt, created_at, cwd, session_id FROM history ORDER BY id").all()).toEqual([
				{ prompt: "first prompt", created_at: 1_767_225_601n, cwd: "/work/a", session_id: "session-a" },
				{ prompt: "third prompt", created_at: 1_767_225_603n, cwd: "/work/b", session_id: "session-b" },
				{ prompt: "user steering", created_at: 1_767_225_604n, cwd: "/work/b", session_id: "session-b" },
			]);
			expect(
				db
					.prepare("SELECT h.prompt FROM history_fts f JOIN history h ON h.id = f.rowid WHERE history_fts MATCH ?")
					.get("third"),
			).toEqual({ prompt: "third prompt" });
		} finally {
			db.close();
		}
	});

	test("session rebuild orders cross-session prompts by finite inner message timestamps", async () => {
		await createHistorySource();
		await writeSession("queued-first", "queued-first", [
			message("first", "2026-01-01T00:00:02.000Z", "first queued", { timestamp: 1_767_225_601_900 }),
		]);
		await writeSession("queued-second", "queued-second", [
			message("second", "2026-01-01T00:00:01.000Z", "second queued", { timestamp: 1_767_225_602_100 }),
		]);

		const result = await runStorageRepair({ target: "history", historySource: "sessions", apply: true, agentDir: root });
		expect(result.status).toBe("ready");
		const db = new Database(result.candidate, { readonly: true, safeIntegers: true });
		try {
			expect(db.prepare("SELECT prompt, created_at FROM history ORDER BY id").all()).toEqual([
				{ prompt: "first queued", created_at: 1_767_225_601n },
				{ prompt: "second queued", created_at: 1_767_225_602n },
			]);
		} finally {
			db.close();
		}
	});

	test("fork copies keep the oldest session origin while retaining fork-only prompts", async () => {
		await createHistorySource();
		const origin = await writeSession(
			"z-origin",
			"origin",
			[message("copied", "2026-01-01T00:00:01.000Z", "copied prompt")],
			"title-slot",
			{ timestamp: "2026-01-01T00:00:00.000Z" },
		);
		await writeSession(
			"a-fork",
			"fork",
			[
				message("copied", "2026-01-01T00:00:01.000Z", "copied prompt"),
				message("fork-only", "2026-01-01T00:00:02.000Z", "fork-only prompt"),
			],
			"title-slot",
			{ timestamp: "2026-01-01T00:00:10.000Z", parentSession: origin },
		);

		const result = await runStorageRepair({ target: "history", historySource: "sessions", apply: true, agentDir: root });
		expect(result.status).toBe("ready");
		const db = new Database(result.candidate, { readonly: true, safeIntegers: true });
		try {
			expect(db.prepare("SELECT prompt, cwd, session_id FROM history ORDER BY id").all()).toEqual([
				{ prompt: "copied prompt", cwd: "/work/z-origin", session_id: "origin" },
				{ prompt: "fork-only prompt", cwd: "/work/a-fork", session_id: "fork" },
			]);
		} finally {
			db.close();
		}
	});

	test("missing-parent fork families select a deterministic origin", async () => {
		await createHistorySource();
		await writeSession(
			"z-later",
			"later",
			[message("copied", "2026-01-01T00:00:01.000Z", "orphan copied")],
			"title-slot",
			{ timestamp: "2026-01-01T00:00:10.000Z", parentSession: "missing-parent" },
		);
		await writeSession(
			"a-earlier",
			"earlier",
			[message("copied", "2026-01-01T00:00:01.000Z", "orphan copied")],
			"title-slot",
			{ timestamp: "2026-01-01T00:00:00.000Z", parentSession: "missing-parent" },
		);

		const result = await runStorageRepair({ target: "history", historySource: "sessions", apply: true, agentDir: root });
		expect(result.status).toBe("ready");
		const db = new Database(result.candidate, { readonly: true, safeIntegers: true });
		try {
			expect(db.prepare("SELECT prompt, cwd, session_id FROM history ORDER BY id").all()).toEqual([
				{ prompt: "orphan copied", cwd: "/work/a-earlier", session_id: "earlier" },
			]);
		} finally {
			db.close();
		}
	});

	test("slotless sessions with CJK and accented prompts rebuild through SQLite FTS verification", async () => {
		await createHistorySource();
		await writeSession(
			"legacy",
			"legacy-session",
			[
				message("synthetic", "2026-01-01T00:00:00.000Z", "synthetic legacy prompt", { synthetic: true }),
				message("m", "2026-01-01T00:00:01.000Z", "東京 café résumé"),
			],
			"legacy-slotless",
		);
		const result = await runStorageRepair({
			target: "history",
			historySource: "sessions",
			apply: true,
			agentDir: root,
		});
		expect(result.status).toBe("ready");
		expect(result.dataLoss).toBe(true);
		const db = new Database(result.candidate, { readonly: true, safeIntegers: true });
		try {
			expect(db.prepare("SELECT prompt FROM history ORDER BY id").all()).toEqual([{ prompt: "東京 café résumé" }]);
		} finally {
			db.close();
		}
	});

	test("history rebuild ignores nested subagent and advisor transcripts", async () => {
		await createHistorySource();
		await writeSession("primary", "primary", [message("primary", "2026-01-01T00:00:01.000Z", "primary prompt")]);
		const subagent = await writeSession(path.join("primary", "__subagent"), "nested", [
			message("nested", "2026-01-01T00:00:02.000Z", "nested prompt"),
		]);
		const advisor = await writeSession(path.join("primary", "__advisor"), "advisor", [
			message("advisor", "2026-01-01T00:00:03.000Z", "advisor prompt"),
		]);
		await fs.promises.appendFile(advisor, '{"type":"message"');

		const result = await runStorageRepair(
			{ target: "history", historySource: "sessions", apply: true, agentDir: root },
			{
				afterSessionManifestParse: () =>
					fs.promises.appendFile(
						subagent,
						`${JSON.stringify(message("late", "2026-01-01T00:00:04.000Z", "late nested prompt"))}\n`,
					),
			},
		);
		expect(result.status).toBe("ready");
		const db = new Database(result.candidate, { readonly: true, safeIntegers: true });
		try {
			expect(db.prepare("SELECT prompt FROM history ORDER BY id").all()).toEqual([{ prompt: "primary prompt" }]);
		} finally {
			db.close();
		}
	});

	test("session manifest changes before publication refuse the candidate", async () => {
		await createHistorySource();
		await writeSession("first", "first-session", [message("m", "2026-01-01T00:00:01.000Z", "first")]);
		const result = await runStorageRepair(
			{ target: "history", historySource: "sessions", apply: true, agentDir: root },
			{
				beforeCandidatePublication: async () => {
					await writeSession("second", "second-session", [message("m", "2026-01-01T00:00:02.000Z", "second")]);
				},
			},
		);
		expect(result.status).toBe("refused");
		expect(result.refusal).toContain("Session directory changed during storage repair");
		expect(result.candidatePublished).toBe(false);
	});

	test("session manifest changes during final cleanup make a published candidate untrusted", async () => {
		await createHistorySource();
		await writeSession("first", "first-session", [message("m", "2026-01-01T00:00:01.000Z", "first")]);
		const result = await runStorageRepair(
			{ target: "history", historySource: "sessions", apply: true, agentDir: root },
			{
				afterCandidatePublication: async () => {
					await writeSession("late", "late-session", [message("m", "2026-01-01T00:00:02.000Z", "late")]);
				},
			},
		);
		expect(result.status).toBe("published-with-warning");
		expect(result.warning).toContain("Session directory changed during storage repair");
		expect(result.candidatePublished).toBe(true);
		expect(result.candidatePathTrusted).toBe(false);
	});

	test("session rebuild skips blank and malformed JSONL records", async () => {
		await createHistorySource();
		const file = await writeSession("primary", "primary-session", [
			message("before", "2026-01-01T00:00:01.000Z", "before damage"),
		]);
		await fs.promises.appendFile(
			file,
			`\n{"type":"message"\n${JSON.stringify(message("after", "2026-01-01T00:00:02.000Z", "after damage"))}\n{"type":"message"`,
		);
		const result = await runStorageRepair({
			target: "history",
			historySource: "sessions",
			apply: true,
			agentDir: root,
		});
		expect(result.status).toBe("ready");
		const db = new Database(result.candidate, { readonly: true, safeIntegers: true });
		try {
			expect(db.prepare("SELECT prompt FROM history ORDER BY id").all()).toEqual([
				{ prompt: "before damage" },
				{ prompt: "after damage" },
			]);
		} finally {
			db.close();
		}
	});

	test("invalid or changing physical sessions refuse while zero sessions remains valid", async () => {
		await createHistorySource();
		let result = await runStorageRepair({
			target: "history",
			historySource: "sessions",
			apply: false,
			agentDir: root,
		});
		expect(result.status).toBe("ready");
		const file = await writeSession("p", "bad", [message("m", "invalid", "prompt")]);
		result = await runStorageRepair({ target: "history", historySource: "sessions", apply: false, agentDir: root });
		expect(result.status).toBe("refused");
		expect(result.refusal).toContain("Invalid timestamp");
		await fs.promises.rm(file);
		const changing = await writeSession("p", "changing", [message("m", "2026-01-01T00:00:01.000Z", "prompt")]);
		result = await runStorageRepair(
			{ target: "history", historySource: "sessions", apply: false, agentDir: root },
			{ afterSessionManifestParse: () => fs.promises.appendFile(changing, "{}\n") },
		);
		expect(result.status).toBe("refused");
		expect(result.refusal).toContain("Session directory changed");
	});

	test("a primary session discovery access error refuses without publishing artifacts", async () => {
		const dbPath = await createHistorySource();
		const sourceBefore = await fingerprint(dbPath);
		const project = path.join(getSessionsDir(root), "denied");
		await writeSession("denied", "session", [message("m", "2026-01-01T00:00:01.000Z", "prompt")]);
		const candidate = path.join(root, "discovery-refused.db");
		const accessError = Object.assign(new Error("session project access denied"), { code: "EACCES" });
		const originalReaddir = fs.promises.readdir;
		const readdirSpy = spyOn(fs.promises, "readdir").mockImplementation(((directory, options) => {
			if (directory === project) return Promise.reject(accessError);
			return Reflect.apply(originalReaddir, fs.promises, [directory, options]);
		}) as typeof fs.promises.readdir);
		try {
			const result = await runStorageRepair({
				target: "history",
				historySource: "sessions",
				apply: true,
				agentDir: root,
				output: candidate,
			});
			expect(result.status).toBe("refused");
			expect(result.refusal).toBe("session project access denied");
			expect(result.backupCreated).toBe(false);
			expect(result.candidatePublished).toBe(false);
			expect(await Bun.file(result.backup).exists()).toBe(false);
			expect(await Bun.file(result.candidate).exists()).toBe(false);
			expect(await fingerprint(dbPath)).toEqual(sourceBefore);
		} finally {
			readdirSpy.mockRestore();
		}
	});

	test("Windows publication skips directory fsync without weakening file verification", async () => {
		await createAgentSource();
		let directorySyncs = 0;
		const result = await runStorageRepair(
			{ target: "agent", apply: true, agentDir: root },
			{
				isWindows: () => true,
				onDirectorySync: () => {
					directorySyncs += 1;
				},
			},
		);
		expect(result.status).toBe("ready");
		expect(result.candidatePathTrusted).toBe(true);
		expect(directorySyncs).toBe(0);
	});

	test("fresh history is empty and reports explicit data loss", async () => {
		await createHistorySource();
		const result = await runStorageRepair({ target: "history", historySource: "fresh", apply: true, agentDir: root });
		expect(result.status).toBe("ready");
		expect(result.dataLoss).toBe(true);
		const db = new Database(result.candidate, { readonly: true });
		try {
			expect(db.prepare("SELECT count(*) AS count FROM history").get()).toEqual({ count: 0 });
		} finally {
			db.close();
		}
	});

	test("injected backup, verification, and no-replace publication failures clean staging and retain valid backup", async () => {
		const dbPath = await createAgentSource();
		const before = await fingerprint(dbPath);
		let snapshotTempDir: string | undefined;
		let result = await runStorageRepair(
			{ target: "agent", apply: true, agentDir: root },
			{
				afterPristineCopy: tempDir => {
					snapshotTempDir = tempDir;
				},
				beforeBackupWrite: () => {
					throw new Error("backup injection");
				},
			},
		);
		expect(result.status).toBe("refused");
		expect(result.backupCreated).toBe(false);
		expect(await fingerprint(dbPath)).toEqual(before);
		await expect(
			fs.promises.lstat(requireValue<string>(snapshotTempDir, "backup snapshot directory")),
		).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(await stageArtifacts(result.backup, "backup")).toEqual([]);

		snapshotTempDir = undefined;
		result = await runStorageRepair(
			{ target: "agent", apply: true, agentDir: root },
			{
				afterPristineCopy: tempDir => {
					snapshotTempDir = tempDir;
				},
				beforeCandidateVerification: () => {
					throw new Error("verification injection");
				},
			},
		);
		expect(result.status).toBe("refused");
		expect(result.backupCreated).toBe(true);
		expect(result.candidatePublished).toBe(false);
		expect(await Bun.file(result.backup).exists()).toBe(true);
		await expect(
			fs.promises.lstat(requireValue<string>(snapshotTempDir, "verification snapshot directory")),
		).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(await stageArtifacts(result.candidate, "candidate")).toEqual([]);

		const racedCandidate = path.join(root, "raced-candidate.db");
		let racerIdentity: FileFingerprint | undefined;
		snapshotTempDir = undefined;
		result = await runStorageRepair(
			{ target: "agent", apply: true, agentDir: root, output: racedCandidate },
			{
				afterPristineCopy: tempDir => {
					snapshotTempDir = tempDir;
				},
				beforeCandidatePublication: async () => {
					await Bun.write(racedCandidate, "racer");
					racerIdentity = await fingerprint(racedCandidate);
				},
			},
		);
		expect(result.status).toBe("refused");
		expect(result.backupCreated).toBe(true);
		expect(result.candidatePublished).toBe(false);
		expect(result.candidatePathTrusted).toBe(false);
		expect(await Bun.file(result.candidate).text()).toBe("racer");
		const staged = requireValue(
			result.checksums.find(checksum => checksum.ephemeral),
			"staged candidate checksum",
		);
		expect(staged.path).not.toBe(result.candidate);
		expect(await fingerprint(racedCandidate)).toEqual(requireValue(racerIdentity, "racer identity"));
		expect(await stageArtifacts(result.candidate, "candidate")).toEqual([]);
		await expect(
			fs.promises.lstat(requireValue<string>(snapshotTempDir, "no-replace publication snapshot directory")),
		).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	test("late source mismatch after candidate link publishes an untrusted sealed candidate", async () => {
		const dbPath = await createAgentSource();
		const candidate = path.join(root, "publication-race.db");
		let snapshotTempDir: string | undefined;
		const result = await runStorageRepair(
			{ target: "agent", apply: true, agentDir: root, output: candidate },
			{
				afterPristineCopy: tempDir => {
					snapshotTempDir = tempDir;
				},
				afterCandidatePublication: () => fs.promises.appendFile(dbPath, "publication race"),
			},
		);
		expect(result.status).toBe("published-with-warning");
		expect(result.warning).toContain("Live source triplet changed during storage repair");
		expect(result.backupCreated).toBe(true);
		expect(result.candidatePublished).toBe(true);
		expect(result.candidatePathTrusted).toBe(false);
		expect(await Bun.file(result.backup).exists()).toBe(true);
		expect(await Bun.file(candidate).exists()).toBe(true);
		await expect(
			fs.promises.lstat(requireValue<string>(snapshotTempDir, "published warning snapshot directory")),
		).rejects.toMatchObject({
			code: "ENOENT",
		});
		const sealed = requireValue(
			result.checksums.find(checksum => checksum.path === candidate && !checksum.ephemeral),
			"linked candidate checksum",
		);
		expect(sealed.ephemeral).toBe(false);
		expect(new Bun.SHA256().update(await Bun.file(candidate).bytes()).digest("hex")).toBe(sealed.sha256);
	});

	test("candidate stage mutation between sealing and publication is refused", async () => {
		await createAgentSource();
		const candidate = path.join(root, "stage-mutation.db");
		const result = await runStorageRepair(
			{ target: "agent", apply: true, agentDir: root, output: candidate },
			{
				beforeCandidatePublication: async () => {
					const stage = requireValue((await stageArtifacts(candidate, "candidate")).at(0), "candidate stage");
					await fs.promises.appendFile(path.join(root, stage), "tampered after sealing");
				},
			},
		);
		expect(result.status).toBe("refused");
		expect(result.refusal).toContain("Publication stage changed after verification");
		expect(result.candidatePublished).toBe(false);
		expect(await Bun.file(candidate).exists()).toBe(false);
		expect(await stageArtifacts(candidate, "candidate")).toEqual([]);
	});

	test("post-link candidate replacement warns without deleting the replacement", async () => {
		const dbPath = await createAgentSource();
		const candidate = path.join(root, "candidate-replacement.db");
		const replacement = "replacement bytes must survive";
		let replacementIdentity: FileFingerprint | undefined;
		const result = await runStorageRepair(
			{ target: "agent", apply: true, agentDir: root, output: candidate },
			{
				afterCandidatePublication: async () => {
					await fs.promises.unlink(candidate);
					await Bun.write(candidate, replacement);
					replacementIdentity = await fingerprint(candidate);
					await fs.promises.appendFile(dbPath, "late invariant refusal");
				},
			},
		);
		expect(result.status).toBe("published-with-warning");
		expect(result.warning).toContain("Published output no longer matches staging file");
		expect(result.candidatePublished).toBe(true);
		expect(result.candidatePathTrusted).toBe(false);
		expect(checksumPathCounts(result)).toEqual({ [result.backup]: 1, [candidate]: 1 });
		expect(await Bun.file(candidate).text()).toBe(replacement);
		expect(await fingerprint(candidate)).toEqual(requireValue(replacementIdentity, "replacement identity"));
		const sealed = requireValue(
			result.checksums.find(checksum => checksum.path === candidate && !checksum.ephemeral),
			"linked candidate checksum",
		);
		expect(new Bun.SHA256().update(await Bun.file(candidate).bytes()).digest("hex")).not.toBe(sealed.sha256);
		expect(await Bun.file(result.backup).exists()).toBe(true);
	});

	test("candidate post-link same-inode same-size mutation fails the SHA proof", async () => {
		await createAgentSource();
		const candidate = path.join(root, "candidate-sha-only.db");
		let mutation: { before: FileFingerprint; after: FileFingerprint } | undefined;
		const result = await runStorageRepair(
			{ target: "agent", apply: true, agentDir: root, output: candidate },
			{
				afterCandidatePublication: async () => {
					const before = await fingerprint(candidate);
					const bytes = await Bun.file(candidate).bytes();
					bytes[0] ^= 0xff;
					const handle = await fs.promises.open(candidate, "r+");
					try {
						await handle.write(bytes, 0, bytes.byteLength, 0);
						await handle.sync();
					} finally {
						await handle.close();
					}
					mutation = { before, after: await fingerprint(candidate) };
				},
			},
		);
		const { before, after } = requireValue(mutation, "candidate SHA-only mutation");
		expect(after).toMatchObject({ dev: before.dev, ino: before.ino, size: before.size });
		expect(after.sha256).not.toBe(before.sha256);
		expect(result.status).toBe("published-with-warning");
		expect(result.candidatePublished).toBe(true);
		expect(result.candidatePathTrusted).toBe(false);
		expect(result.warning).toContain("Published output content changed");
	});

	test("candidate post-link byte-identical replacement fails the inode proof", async () => {
		await createAgentSource();
		const candidate = path.join(root, "candidate-inode-only.db");
		let mutation: { before: FileFingerprint; after: FileFingerprint } | undefined;
		const result = await runStorageRepair(
			{ target: "agent", apply: true, agentDir: root, output: candidate },
			{
				afterCandidatePublication: async () => {
					const before = await fingerprint(candidate);
					const bytes = await Bun.file(candidate).bytes();
					await fs.promises.unlink(candidate);
					await Bun.write(candidate, bytes);
					mutation = { before, after: await fingerprint(candidate) };
				},
			},
		);
		const { before, after } = requireValue(mutation, "candidate inode-only mutation");
		expect(after).toMatchObject({ dev: before.dev, size: before.size, sha256: before.sha256 });
		expect(after.ino).not.toBe(before.ino);
		expect(result.status).toBe("published-with-warning");
		expect(result.candidatePublished).toBe(true);
		expect(result.candidatePathTrusted).toBe(false);
		expect(result.warning).toContain("Published output no longer matches staging file");
	});

	test("candidate stage-unlink failure warns after proving the linked output", async () => {
		await createAgentSource();
		const candidate = path.join(root, "candidate-stage-unlink.db");
		const result = await runStorageRepair(
			{ target: "agent", apply: true, agentDir: root, output: candidate },
			{
				beforeCandidateStageUnlink: () => {
					throw new Error("candidate stage-unlink injection");
				},
			},
		);
		expect(result.status).toBe("published-with-warning");
		expect(result.warning).toContain("candidate stage-unlink injection");
		expect(result.candidatePublished).toBe(true);
		expect(result.candidatePathTrusted).toBe(false);
		expect(await Bun.file(result.backup).exists()).toBe(true);
		expect(await Bun.file(candidate).exists()).toBe(true);
	});

	test("candidate directory-sync failure warns and leaves the published candidate untouched", async () => {
		await createAgentSource();
		const candidate = path.join(root, "candidate-directory-sync.db");
		const result = await runStorageRepair(
			{ target: "agent", apply: true, agentDir: root, output: candidate },
			{
				beforeCandidateDirectorySync: () => {
					throw new Error("candidate directory-sync injection");
				},
			},
		);
		expect(result.status).toBe("published-with-warning");
		expect(result.warning).toContain("candidate directory-sync injection");
		expect(result.candidatePublished).toBe(true);
		expect(result.candidatePathTrusted).toBe(false);
		expect(await Bun.file(result.backup).exists()).toBe(true);
		const sealed = requireValue(
			result.checksums.find(checksum => checksum.path === candidate && !checksum.ephemeral),
			"linked candidate checksum",
		);
		expect(sealed.ephemeral).toBe(false);
		expect(new Bun.SHA256().update(await Bun.file(candidate).bytes()).digest("hex")).toBe(sealed.sha256);
	});

	test("candidate directory-sync replacement is reported as untrusted without deleting the replacement", async () => {
		await createAgentSource();
		const candidate = path.join(root, "candidate-directory-sync-replacement.db");
		const replacement = "directory sync replacement must survive";
		let replacementIdentity: FileFingerprint | undefined;
		const result = await runStorageRepair(
			{ target: "agent", apply: true, agentDir: root, output: candidate },
			{
				beforeCandidateDirectorySync: async () => {
					await fs.promises.unlink(candidate);
					await Bun.write(candidate, replacement);
					replacementIdentity = await fingerprint(candidate);
				},
			},
		);
		expect(result.status).toBe("published-with-warning");
		expect(result.warning).toContain("Published output no longer matches staging file");
		expect(result.candidatePublished).toBe(true);
		expect(result.candidatePathTrusted).toBe(false);
		expect(await Bun.file(candidate).text()).toBe(replacement);
		expect(await fingerprint(candidate)).toEqual(requireValue(replacementIdentity, "replacement identity"));
	});

	test("backup post-link hook failure records the link without a verified checksum", async () => {
		await createAgentSource();
		const result = await runStorageRepair(
			{ target: "agent", apply: true, agentDir: root },
			{
				afterBackupLink: () => {
					throw new Error("backup post-link injection");
				},
			},
		);
		expect(result.status).toBe("refused");
		expect(result.backupCreated).toBe(true);
		expect(result.candidatePublished).toBe(false);
		expect(checksumPathCounts(result)).toEqual({});
		expect(await Bun.file(result.candidate).exists()).toBe(false);
		expect(await Bun.file(result.backup).exists()).toBe(true);
		const entries = await fs.promises.readdir(root);
		expect(entries.some(name => name.startsWith(`.${path.basename(result.backup)}.backup-`))).toBe(false);
	});

	test("backup post-link replacement refuses without claiming the replacement as verified", async () => {
		await createAgentSource();
		const replacement = "backup replacement must survive";
		let replacementIdentity: FileFingerprint | undefined;
		const result = await runStorageRepair(
			{ target: "agent", apply: true, agentDir: root },
			{
				afterBackupLink: async () => {
					const directory = path.dirname(getAgentDbPath(root));
					const name = (await fs.promises.readdir(directory)).find(entry => entry.endsWith(".tar"));
					if (!name) throw new Error("Linked backup is missing");
					const backup = path.join(directory, name);
					await fs.promises.unlink(backup);
					await Bun.write(backup, replacement);
					replacementIdentity = await fingerprint(backup);
				},
			},
		);
		expect(result.status).toBe("refused");
		expect(result.backupCreated).toBe(true);
		expect(checksumPathCounts(result)).toEqual({});
		expect(await Bun.file(result.backup).text()).toBe(replacement);
		expect(await fingerprint(result.backup)).toEqual(requireValue(replacementIdentity, "replacement identity"));
	});

	test("backup post-link same-inode same-size mutation fails the SHA proof", async () => {
		await createAgentSource();
		let mutation: { before: FileFingerprint; after: FileFingerprint } | undefined;
		const result = await runStorageRepair(
			{ target: "agent", apply: true, agentDir: root },
			{
				afterBackupLink: async () => {
					const directory = path.dirname(getAgentDbPath(root));
					const name = requireValue(
						(await fs.promises.readdir(directory)).find(entry => entry.endsWith(".tar")),
						"linked backup",
					);
					const backup = path.join(directory, name);
					const before = await fingerprint(backup);
					const bytes = await Bun.file(backup).bytes();
					bytes[0] ^= 0xff;
					const handle = await fs.promises.open(backup, "r+");
					try {
						await handle.write(bytes, 0, bytes.byteLength, 0);
						await handle.sync();
					} finally {
						await handle.close();
					}
					mutation = { before, after: await fingerprint(backup) };
				},
			},
		);
		const { before, after } = requireValue(mutation, "backup SHA-only mutation");
		expect(after).toMatchObject({ dev: before.dev, ino: before.ino, size: before.size });
		expect(after.sha256).not.toBe(before.sha256);
		expect(result.status).toBe("refused");
		expect(result.backupCreated).toBe(true);
		expect(result.candidatePublished).toBe(false);
		expect(checksumPathCounts(result)).toEqual({});
		expect(result.refusal).toContain("Published output content changed");
	});

	test("backup post-link byte-identical replacement fails the inode proof", async () => {
		await createAgentSource();
		let mutation: { before: FileFingerprint; after: FileFingerprint } | undefined;
		const result = await runStorageRepair(
			{ target: "agent", apply: true, agentDir: root },
			{
				afterBackupLink: async () => {
					const directory = path.dirname(getAgentDbPath(root));
					const name = requireValue(
						(await fs.promises.readdir(directory)).find(entry => entry.endsWith(".tar")),
						"linked backup",
					);
					const backup = path.join(directory, name);
					const before = await fingerprint(backup);
					const bytes = await Bun.file(backup).bytes();
					await fs.promises.unlink(backup);
					await Bun.write(backup, bytes);
					mutation = { before, after: await fingerprint(backup) };
				},
			},
		);
		const { before, after } = requireValue(mutation, "backup inode-only mutation");
		expect(after).toMatchObject({ dev: before.dev, size: before.size, sha256: before.sha256 });
		expect(after.ino).not.toBe(before.ino);
		expect(result.status).toBe("refused");
		expect(result.backupCreated).toBe(true);
		expect(result.candidatePublished).toBe(false);
		expect(checksumPathCounts(result)).toEqual({});
		expect(result.refusal).toContain("Published output no longer matches staging file");
	});

	test("primary refusal and cleanup invariant failures retain both causes in deterministic order", async () => {
		const dbPath = await createAgentSource();
		const result = await runStorageRepair(
			{ target: "agent", apply: false, agentDir: root },
			{
				beforeCandidateVerification: async () => {
					await fs.promises.appendFile(dbPath, "cleanup race");
					throw new Error("primary verification refusal");
				},
			},
		);
		expect(result.status).toBe("refused");
		expect(result.refusal).toBe(
			'Storage repair refusal: {"primary":"primary verification refusal","cleanupInvariant":["Live source triplet changed during storage repair"]}',
		);
		expect(result.objects.at(-1)?.detail).toBe(result.refusal);
	});

	test("backup publication consumes file-backed members without eager BunFile bytes reads", async () => {
		await createAgentSource();
		const originalFile = Bun.file;
		const fileSpy = spyOn(Bun, "file").mockImplementation(((input, options) => {
			const file = Reflect.apply(originalFile, Bun, [input, options]) as Bun.BunFile;
			return new Proxy(file, {
				get(target, property) {
					if (property === "bytes") {
						return () => {
							throw new Error("eager BunFile.bytes read");
						};
					}
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		}) as typeof Bun.file);
		let result: StorageRepairResult;
		try {
			result = await runStorageRepair({ target: "agent", apply: true, agentDir: root });
		} finally {
			fileSpy.mockRestore();
		}
		expect(result.status).toBe("ready");
		expect(result.backupCreated).toBe(true);
		expect(await Bun.file(result.backup).exists()).toBe(true);
	});

	test("text and JSON reports are structured, nonzero-compatible, and include quarantine instructions", async () => {
		await createHistorySource();
		let result = await runGcCommand({
			flags: { agentDir: root, repairStorage: "history", historySource: "fresh", apply: true },
		});
		expect(result.repair?.manualNextStep).toContain("quarantine");
		expect(stdout.join("")).toContain("manual next step:");
		expect(stdout.join("")).toContain("data loss: true");
		expect(stdout.join("")).toContain("candidate: ");
		expect(stdout.join("")).toContain("(published)");
		expect(stdout.join("")).toContain("candidate path trusted: true");
		stdout = [];
		result = await runGcCommand({
			flags: { agentDir: root, repairStorage: "history", historySource: "fresh", json: true },
		});
		const parsed = JSON.parse(stdout.join(""));
		expect(parsed.repair.status).toBe("ready");
		expect(parsed.repair.dataLoss).toBe(true);
		expect(parsed.repair.candidatePublished).toBe(false);
		expect(parsed.repair.candidatePathTrusted).toBe(false);
		expect(parsed.repair.manualNextStep).toContain("quarantine");
		expect(
			collectGcErrors({
				agentDir: root,
				apply: true,
				lockPath: path.join(root, "gc.lock"),
				repair: { ...result.repair!, status: "published-with-warning", warning: "late source mismatch" },
			}),
		).toEqual(["repair: late source mismatch"]);
	});

	test("session-source text reports warn about irreversible history loss", async () => {
		await createHistorySource();
		await writeSession("project", "session", [message("m", "2026-01-01T00:00:01.000Z", "prompt")]);
		const result = await runGcCommand({
			flags: { agentDir: root, repairStorage: "history", historySource: "sessions" },
		});
		expect(result.repair?.dataLoss).toBe(true);
		expect(stdout.join("")).toContain("session rebuild retains only session messages");
		expect(stdout.join("")).toContain("stable row IDs are not preserved");
	});

	test("dry-run and published candidates report distinct checksum lifecycles", async () => {
		await createAgentSource();
		const dryRun = await runStorageRepair({ target: "agent", apply: false, agentDir: root });
		const staged = requireValue(
			dryRun.checksums.find(checksum => checksum.ephemeral),
			"staged candidate checksum",
		);
		expect(staged.path).not.toBe(dryRun.candidate);
		expect(staged.ephemeral).toBe(true);

		const published = await runStorageRepair({ target: "agent", apply: true, agentDir: root });
		const candidate = requireValue(
			published.checksums.find(checksum => checksum.path === published.candidate),
			"published candidate checksum",
		);
		expect(candidate.ephemeral).toBe(false);
	});

	test("text and JSON reports label staged candidate digests as ephemeral", async () => {
		await createAgentSource();
		await runGcCommand({ flags: { agentDir: root, repairStorage: "agent" } });
		expect(stdout.join("")).toContain("(ephemeral staging)");
		stdout = [];
		await runGcCommand({ flags: { agentDir: root, repairStorage: "agent", json: true } });
		const parsed = JSON.parse(stdout.join(""));
		const staged = parsed.repair.checksums.find((checksum: { ephemeral: boolean }) => checksum.ephemeral);
		expect(staged.path).not.toBe(parsed.repair.candidate);
		expect(staged.ephemeral).toBe(true);
	});

	test("backup manifest preserves frozen source member metadata", async () => {
		const dbPath = await createAgentSource();
		await Promise.all([
			fs.promises.chmod(dbPath, 0o640),
			fs.promises.chmod(`${dbPath}-wal`, 0o620),
			fs.promises.chmod(`${dbPath}-shm`, 0o600),
		]);
		const [main, wal, shm] = await Promise.all(
			sourceTripletPaths(dbPath).map(async source => {
				const frozen = await fingerprint(source);
				return {
					archiveName: `source/${path.basename(source)}`,
					size: Number(frozen.size),
					mode: Number(frozen.mode & 0o7777n),
					uid: frozen.uid.toString(),
					gid: frozen.gid.toString(),
					sha256: frozen.sha256,
				};
			}),
		);
		const result = await runStorageRepair({ target: "agent", apply: true, agentDir: root });
		if (result.status !== "ready") throw new Error(result.refusal);
		const files = await new Bun.Archive(await Bun.file(result.backup).bytes()).files();
		const manifest = JSON.parse((await files.get("manifest.json")?.text()) ?? "{}");
		expect(manifest.members).toEqual({ main, wal, shm });
	});
});
