import { Database, constants as sqliteConstants } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizePathForComparison } from "@oh-my-pi/pi-utils";
import { type ArchiveMemberContent, archiveFileMember, extractFileBackedTar, writeArchive } from "../utils/zip";
import type {
	CanonicalSchemaObject,
	FrozenSqliteSnapshot,
	PristineSnapshot,
	SourceMemberManifest,
	SourceTripletManifest,
	StorageRepairChecksum,
	StorageRepairResult,
} from "./storage-repair-types";

const COPY_BUFFER_BYTES = 1024 * 1024;
const BACKUP_MANIFEST_NAME = "manifest.json";

interface SchemaObjectRow {
	type: string;
	name: string;
	tbl_name: string;
	sql: string | null;
}

type SqliteValue = string | number | bigint | Uint8Array | null;

interface SnapshotFingerprint {
	schema: CanonicalSchemaObject[];
	versions: Record<string, string[]>;
	corruption: string[];
}

export function errorMessage(error: unknown): string {
	if (error instanceof AggregateError) {
		return `${error.message}: ${error.errors.map(errorMessage).join("; ")}`;
	}
	return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = error.code;
	return typeof code === "string" ? code : undefined;
}

export function assertInvariant(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

export function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, current: unknown) =>
		typeof current === "bigint" ? current.toString() : current,
	);
}

function numberFromBigInt(value: bigint, label: string): number {
	const result = Number(value);
	assertInvariant(Number.isSafeInteger(result), `${label} exceeds JavaScript's safe integer range`);
	return result;
}

function normalizeSql(sql: string): string {
	return sql
		.trim()
		.replace(/\s+/gu, " ")
		.replace(/\s*([(),=])\s*/gu, "$1")
		.toLowerCase();
}

function canonicalRow(row: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(row).sort()) {
		const value = row[key];
		result[key] = typeof value === "bigint" ? value.toString() : value;
	}
	return result;
}

function sqliteRows(db: Database, sql: string, ...bindings: SqliteValue[]): Array<Record<string, unknown>> {
	return db.prepare(sql).all(...bindings) as Array<Record<string, unknown>>;
}

function schemaObjects(db: Database): SchemaObjectRow[] {
	return db
		.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
		.all() as SchemaObjectRow[];
}

function canonicalTable(db: Database, object: SchemaObjectRow): CanonicalSchemaObject {
	const item: CanonicalSchemaObject = {
		kind: object.type,
		name: object.name,
		table: object.tbl_name,
		columns: sqliteRows(db, "SELECT * FROM pragma_table_xinfo(?) ORDER BY cid", object.name).map(canonicalRow),
		foreignKeys: sqliteRows(db, "SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq", object.name).map(
			canonicalRow,
		),
	};
	item.indexes = sqliteRows(db, "SELECT * FROM pragma_index_list(?) ORDER BY name", object.name).map(index => {
		const name = index.name;
		assertInvariant(typeof name === "string", `Invalid index metadata for ${object.name}`);
		return {
			...canonicalRow(index),
			columns: sqliteRows(db, "SELECT * FROM pragma_index_xinfo(?) ORDER BY seqno", name).map(canonicalRow),
		};
	});
	if (object.sql && /\b(?:check|collate|generated|without\s+rowid|strict|using)\b/iu.test(object.sql)) {
		item.sql = normalizeSql(object.sql);
	}
	return item;
}

export function canonicalSchema(db: Database): CanonicalSchemaObject[] {
	return schemaObjects(db).map(object => {
		if (object.type === "table") return canonicalTable(db, object);
		const item: CanonicalSchemaObject = { kind: object.type, name: object.name, table: object.tbl_name };
		if (object.type === "trigger" || object.type === "view") {
			assertInvariant(typeof object.sql === "string", `Missing SQL for ${object.type} ${object.name}`);
			item.sql = normalizeSql(object.sql);
		} else if (object.type === "index" && object.sql && /\bwhere\b|\([^)]*\([^)]*\)/iu.test(object.sql)) {
			item.sql = normalizeSql(object.sql);
		}
		return item;
	});
}

function versionManifest(db: Database): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const table of ["schema_version", "auth_schema_version"] as const) {
		const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table);
		if (!exists) continue;
		const rows =
			table === "schema_version"
				? sqliteRows(db, "SELECT version FROM schema_version ORDER BY version")
				: sqliteRows(db, "SELECT id, version FROM auth_schema_version ORDER BY id");
		result[table] = rows.map(stableJson);
	}
	return result;
}

function corruptionManifest(db: Database): string[] {
	try {
		return db
			.prepare("PRAGMA integrity_check")
			.values()
			.map(row => String(row[0]))
			.sort();
	} catch (error) {
		return [`error: ${errorMessage(error)}`];
	}
}

function inspect(db: Database): SnapshotFingerprint {
	return { schema: canonicalSchema(db), versions: versionManifest(db), corruption: corruptionManifest(db) };
}

function openImmutableSnapshot(workingMain: string): FrozenSqliteSnapshot {
	const working = new Database(workingMain, { safeIntegers: true });
	let serialized: Buffer | null = null;
	let before: SnapshotFingerprint | null = null;
	try {
		try {
			working.exec("BEGIN");
			working.prepare("SELECT rootpage FROM sqlite_schema ORDER BY rootpage").all();
			before = inspect(working);
			if (working.inTransaction) working.exec("ROLLBACK");
		} catch (error) {
			if (!working.inTransaction) throw error;
			try {
				working.exec("ROLLBACK");
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], "Working SQLite snapshot failed and rollback also failed");
			}
			throw error;
		}
		working.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		working.exec("PRAGMA journal_mode=DELETE");
		serialized = working.serialize();
	} finally {
		working.close();
	}
	assertInvariant(serialized && before, "Working SQLite snapshot did not serialize");
	const immutable = Database.deserialize(serialized, { readonly: true, safeIntegers: true });
	const after = inspect(immutable);
	if (stableJson(before) === stableJson(after)) return { db: immutable, ...after };
	immutable.close();
	throw new Error("Serialized SQLite snapshot changed its schema/version/corruption manifest");
}

async function lstatIfPresent(target: string): Promise<fs.Stats | null> {
	try {
		return await fs.promises.lstat(target);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return null;
		throw error;
	}
}

async function openSourceNoAtime(file: string): Promise<fs.promises.FileHandle> {
	const noAtime = fs.constants.O_NOATIME ?? 0;
	try {
		return await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | noAtime);
	} catch (error) {
		if (noAtime === 0 || (codeOf(error) !== "EPERM" && codeOf(error) !== "EINVAL")) throw error;
		return fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	}
}

async function hashHandle(handle: fs.promises.FileHandle): Promise<{ sha256: string; size: number }> {
	const hash = new Bun.SHA256();
	const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
	let position = 0;
	for (;;) {
		const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
		if (bytesRead === 0) return { sha256: hash.digest("hex"), size: position };
		hash.update(buffer.subarray(0, bytesRead));
		position += bytesRead;
	}
}

async function hashFile(file: string, source: boolean): Promise<{ sha256: string; size: number }> {
	const handle = source ? await openSourceNoAtime(file) : await fs.promises.open(file, "r");
	try {
		return await hashHandle(handle);
	} finally {
		await handle.close();
	}
}

async function manifestMember(
	role: "main" | "wal" | "shm",
	file: string,
	archiveName: string,
): Promise<SourceMemberManifest | null> {
	let stat: fs.BigIntStats;
	try {
		stat = await fs.promises.lstat(file, { bigint: true });
	} catch (error) {
		if (codeOf(error) === "ENOENT") return null;
		throw error;
	}
	assertInvariant(stat.isFile() && !stat.isSymbolicLink(), `Source ${role} is not a regular file: ${file}`);
	const digest = await hashFile(file, true);
	assertInvariant(digest.size === numberFromBigInt(stat.size, `${role} size`), `Source ${role} changed while hashing`);
	return {
		role,
		path: file,
		archiveName,
		dev: stat.dev.toString(),
		ino: stat.ino.toString(),
		size: digest.size,
		mtimeNs: stat.mtimeNs.toString(),
		ctimeNs: stat.ctimeNs.toString(),
		mode: Number(stat.mode & 0o7777n),
		uid: stat.uid.toString(),
		gid: stat.gid.toString(),
		sha256: digest.sha256,
	};
}

async function manifestTriplet(source: string): Promise<SourceTripletManifest> {
	const basename = path.basename(source);
	const members = {
		main: await manifestMember("main", source, `source/${basename}`),
		wal: await manifestMember("wal", `${source}-wal`, `source/${basename}-wal`),
		shm: await manifestMember("shm", `${source}-shm`, `source/${basename}-shm`),
	};
	assertInvariant(members.main, `Storage source does not exist: ${source}`);
	return { version: 1, source, members };
}

async function copyAndHash(
	source: string,
	destination: string,
	sourceNoAtime: boolean,
): Promise<{ path: string; sha256: string; size: number }> {
	const input = sourceNoAtime ? await openSourceNoAtime(source) : await fs.promises.open(source, "r");
	const output = await fs.promises.open(
		destination,
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
		0o600,
	);
	const hash = new Bun.SHA256();
	const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
	let position = 0;
	try {
		for (;;) {
			const { bytesRead } = await input.read(buffer, 0, buffer.byteLength, position);
			if (bytesRead === 0) break;
			const chunk = buffer.subarray(0, bytesRead);
			let written = 0;
			while (written < bytesRead) {
				const result = await output.write(chunk, written, bytesRead - written, position + written);
				assertInvariant(result.bytesWritten > 0, `Short write while copying ${source}`);
				written += result.bytesWritten;
			}
			hash.update(chunk);
			position += bytesRead;
		}
		await output.sync();
	} finally {
		await output.close();
		await input.close();
	}
	return { path: destination, sha256: hash.digest("hex"), size: position };
}

async function copyTriplet(
	manifest: SourceTripletManifest,
	destinationDir: string,
	sourceNoAtime: boolean,
): Promise<Record<"main" | "wal" | "shm", string | null>> {
	const result: Record<"main" | "wal" | "shm", string | null> = { main: null, wal: null, shm: null };
	for (const role of ["main", "wal", "shm"] as const) {
		const member = manifest.members[role];
		if (!member) continue;
		const destination = path.join(destinationDir, path.basename(member.path));
		const copied = await copyAndHash(member.path, destination, sourceNoAtime);
		assertInvariant(copied.sha256 === member.sha256 && copied.size === member.size, `Unstable ${role} snapshot`);
		result[role] = destination;
	}
	return result;
}

async function sealTriplet(
	manifest: SourceTripletManifest,
	paths: Record<"main" | "wal" | "shm", string | null>,
): Promise<void> {
	for (const role of ["main", "wal", "shm"] as const) {
		const member = manifest.members[role];
		const file = paths[role];
		assertInvariant((member === null) === (file === null), `Snapshot ${role} membership mismatch`);
		if (!member || !file) continue;
		const digest = await hashFile(file, false);
		assertInvariant(digest.sha256 === member.sha256 && digest.size === member.size, `Snapshot ${role} seal mismatch`);
	}
}

export async function sourceStillMatches(pre: SourceTripletManifest): Promise<void> {
	assertInvariant(
		stableJson(pre) === stableJson(await manifestTriplet(pre.source)),
		"Live source triplet changed during storage repair",
	);
}

export async function preparePristineSnapshot(
	source: string,
	inspectSqlite: boolean,
	afterPristineCopy?: (tempDir: string) => void | Promise<void>,
): Promise<PristineSnapshot> {
	const manifest = await manifestTriplet(source);
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-storage-repair-"));
	try {
		await fs.promises.chmod(tempDir, 0o700);
		const pristineDir = path.join(tempDir, "pristine");
		const workingDir = path.join(tempDir, "working");
		await fs.promises.mkdir(pristineDir, { mode: 0o700 });
		await fs.promises.mkdir(workingDir, { mode: 0o700 });
		const pristine = await copyTriplet(manifest, pristineDir, true);
		await sealTriplet(manifest, pristine);
		await afterPristineCopy?.(tempDir);
		await sourceStillMatches(manifest);
		const copiedManifest: SourceTripletManifest = {
			...manifest,
			members: {
				main: manifest.members.main ? { ...manifest.members.main, path: pristine.main ?? "" } : null,
				wal: manifest.members.wal ? { ...manifest.members.wal, path: pristine.wal ?? "" } : null,
				shm: manifest.members.shm ? { ...manifest.members.shm, path: pristine.shm ?? "" } : null,
			},
		};
		const working = await copyTriplet(copiedManifest, workingDir, false);
		await sealTriplet(manifest, working);
		assertInvariant(working.main, "Working main database is missing");
		return {
			tempDir,
			manifest,
			paths: pristine,
			immutable: inspectSqlite ? openImmutableSnapshot(working.main) : null,
		};
	} catch (error) {
		await fs.promises.rm(tempDir, { recursive: true, force: true });
		throw error;
	}
}

export async function cleanupSnapshot(snapshot: PristineSnapshot | null): Promise<void> {
	if (!snapshot) return;
	try {
		snapshot.immutable?.db.close();
	} finally {
		await fs.promises.rm(snapshot.tempDir, { recursive: true, force: true });
	}
}

async function canonicalNewPath(target: string): Promise<string> {
	const absolute = path.resolve(target);
	assertInvariant((await lstatIfPresent(absolute)) === null, `Repair output already exists: ${absolute}`);
	const parent = await fs.promises.realpath(path.dirname(absolute));
	const canonical = path.join(parent, path.basename(absolute));
	assertInvariant((await lstatIfPresent(canonical)) === null, `Repair output already exists: ${canonical}`);
	return canonical;
}

export interface ResolveArtifactPathOptions {
	artifactSlug?: () => string;
	platform?: () => NodeJS.Platform;
}

type PathComparisonMode = "posix" | "darwin" | "win32";

function pathComparisonMode(platform: NodeJS.Platform): PathComparisonMode {
	if (platform === "win32") return "win32";
	if (platform === "darwin") return "darwin";
	return "posix";
}

function pathComparisonKey(target: string, mode: PathComparisonMode): string {
	let normalized = normalizePathForComparison(target).normalize("NFC");
	if (mode === "win32") {
		// Inputs are canonical: path.resolve plus realpath(parent) means dot parents cannot survive here.
		normalized = normalized
			.split(path.sep)
			.map(component => component.replace(/[. ]+$/u, ""))
			.join(path.sep);
	}
	return mode === "posix" ? normalized : normalized.toUpperCase().toLowerCase().normalize("NFC");
}

function pathsAlias(left: string, right: string, mode: PathComparisonMode): boolean {
	return pathComparisonKey(left, mode) === pathComparisonKey(right, mode);
}

export async function resolveArtifactPaths(
	source: string,
	output?: string,
	options: ResolveArtifactPathOptions = {},
): Promise<{ backup: string; candidate: string }> {
	const slug =
		options.artifactSlug?.() ??
		`${new Date().toISOString().replace(/[-:.TZ]/gu, "")}-${crypto.randomUUID().slice(0, 8)}`;
	const candidate = await canonicalNewPath(output ?? `${source}.salvage-${slug}.db`);
	const backup = await canonicalNewPath(`${source}.salvage-${slug}.tar`);
	const sourceAbsolute = path.resolve(source);
	const canonicalSource = path.join(
		await fs.promises.realpath(path.dirname(sourceAbsolute)),
		path.basename(sourceAbsolute),
	);
	const mode = pathComparisonMode(options.platform?.() ?? process.platform);
	const forbidden = [canonicalSource, `${canonicalSource}-wal`, `${canonicalSource}-shm`];
	assertInvariant(
		!forbidden.some(
			forbiddenPath => pathsAlias(candidate, forbiddenPath, mode) || pathsAlias(backup, forbiddenPath, mode),
		),
		"Repair artifact collides with source triplet",
	);
	assertInvariant(!pathsAlias(candidate, backup, mode), "Candidate and backup paths collide");
	return { backup, candidate };
}

export async function exclusiveStage(finalPath: string, label: string): Promise<string> {
	const stage = path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.${label}-${crypto.randomUUID()}.tmp`);
	const handle = await fs.promises.open(
		stage,
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
		0o600,
	);
	await handle.close();
	return stage;
}

export async function removeOwnedFile(target: string | null): Promise<void> {
	if (!target) return;
	try {
		await fs.promises.unlink(target);
	} catch (error) {
		if (codeOf(error) !== "ENOENT") throw error;
	}
}

export async function removeCandidateSidecars(candidate: string): Promise<void> {
	await removeOwnedFile(`${candidate}-wal`);
	await removeOwnedFile(`${candidate}-shm`);
}

async function syncFile(file: string): Promise<void> {
	const handle = await fs.promises.open(file, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectory(dir: string, isWindows: () => boolean, onDirectorySync?: () => void): Promise<void> {
	if (isWindows()) return;
	onDirectorySync?.();
	const handle = await fs.promises.open(dir, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

interface PublicationHooks {
	afterLink?: () => void | Promise<void>;
	beforeStageUnlink?: () => void | Promise<void>;
	beforeDirectorySync?: () => void | Promise<void>;
	isWindows?: () => boolean;
	onDirectorySync?: () => void;
}

export interface PublishedFile {
	dev: bigint;
	ino: bigint;
	size: bigint;
	sha256: string;
}

async function sealedFile(file: string): Promise<PublishedFile> {
	const stat = await fs.promises.lstat(file, { bigint: true });
	assertInvariant(stat.isFile() && !stat.isSymbolicLink(), `Publication stage is not a regular file: ${file}`);
	const digest = await hashFile(file, false);
	const confirmed = await fs.promises.lstat(file, { bigint: true });
	assertInvariant(
		confirmed.isFile() &&
			!confirmed.isSymbolicLink() &&
			confirmed.dev === stat.dev &&
			confirmed.ino === stat.ino &&
			confirmed.size === stat.size,
		`Publication stage changed while sealing: ${file}`,
	);
	return { dev: stat.dev, ino: stat.ino, size: stat.size, sha256: digest.sha256 };
}

async function verifySealedFile(file: string, expected: PublishedFile): Promise<void> {
	const actual = await sealedFile(file);
	assertInvariant(
		actual.dev === expected.dev &&
			actual.ino === expected.ino &&
			actual.size === expected.size &&
			actual.sha256 === expected.sha256,
		`Publication stage changed after verification: ${file}`,
	);
}

async function verifyPublishedFile(stage: string, finalPath: string, expected: PublishedFile): Promise<void> {
	const [stageStat, finalStat] = await Promise.all([
		fs.promises.lstat(stage, { bigint: true }),
		fs.promises.lstat(finalPath, { bigint: true }),
	]);
	assertInvariant(
		stageStat.isFile() &&
			!stageStat.isSymbolicLink() &&
			finalStat.isFile() &&
			!finalStat.isSymbolicLink() &&
			stageStat.dev === expected.dev &&
			stageStat.ino === expected.ino &&
			stageStat.size === expected.size &&
			finalStat.dev === expected.dev &&
			finalStat.ino === expected.ino &&
			finalStat.size === expected.size,
		`Published output no longer matches staging file: ${finalPath}`,
	);
	assertInvariant(
		(await hashFile(finalPath, false)).sha256 === expected.sha256,
		`Published output content changed: ${finalPath}`,
	);
}

async function verifyFinalFile(finalPath: string, expected: PublishedFile): Promise<void> {
	const finalStat = await fs.promises.lstat(finalPath, { bigint: true });
	assertInvariant(
		finalStat.isFile() &&
			!finalStat.isSymbolicLink() &&
			finalStat.dev === expected.dev &&
			finalStat.ino === expected.ino &&
			finalStat.size === expected.size,
		`Published output no longer matches staging file: ${finalPath}`,
	);
	assertInvariant(
		(await hashFile(finalPath, false)).sha256 === expected.sha256,
		`Published output content changed: ${finalPath}`,
	);
}

async function runPublicationHook(
	hook: (() => void | Promise<void>) | undefined,
	verify: () => Promise<void>,
): Promise<void> {
	if (!hook) return;
	try {
		await hook();
	} catch (error) {
		try {
			await verify();
		} catch (verificationError) {
			throw new AggregateError(
				[error, verificationError],
				"Publication hook failed and changed the output identity",
			);
		}
		throw error;
	}
	await verify();
}

async function publishNoReplace(
	stage: string,
	finalPath: string,
	expected: PublishedFile,
	onLinked: () => void,
	hooks: PublicationHooks = {},
): Promise<void> {
	await verifySealedFile(stage, expected);
	await fs.promises.link(stage, finalPath);
	onLinked();
	await verifyPublishedFile(stage, finalPath, expected);
	await runPublicationHook(hooks.afterLink, () => verifyPublishedFile(stage, finalPath, expected));
	await runPublicationHook(hooks.beforeStageUnlink, () => verifyPublishedFile(stage, finalPath, expected));
	await fs.promises.unlink(stage);
	await runPublicationHook(hooks.beforeDirectorySync, () => verifyFinalFile(finalPath, expected));
	await syncDirectory(
		path.dirname(finalPath),
		hooks.isWindows ?? (() => process.platform === "win32"),
		hooks.onDirectorySync,
	);
	await verifyFinalFile(finalPath, expected);
}

function backupManifestJson(manifest: SourceTripletManifest): string {
	return `${stableJson({
		formatVersion: 1,
		source: manifest.source,
		members: Object.fromEntries(
			(["main", "wal", "shm"] as const).map(role => {
				const member = manifest.members[role];
				return [
					role,
					member
						? {
								archiveName: member.archiveName,
								size: member.size,
								mode: member.mode,
								uid: member.uid,
								gid: member.gid,
								sha256: member.sha256,
							}
						: null,
				];
			}),
		),
	})}\n`;
}

async function verifyBackup(
	stage: string,
	manifest: SourceTripletManifest,
	names: Set<string>,
	tempDir: string,
): Promise<void> {
	const verificationDir = await fs.promises.mkdtemp(path.join(tempDir, "backup-verify-"));
	try {
		const archiveStat = await fs.promises.stat(stage);
		const extracted = await extractFileBackedTar(stage, archiveStat.size, verificationDir);
		assertInvariant(extracted === names.size, "Backup archive contains unexpected members");
		const manifestPath = path.join(verificationDir, BACKUP_MANIFEST_NAME);
		assertInvariant(
			(await fs.promises.readFile(manifestPath, "utf8")) === backupManifestJson(manifest),
			"Backup manifest verification failed",
		);
		for (const role of ["main", "wal", "shm"] as const) {
			const member = manifest.members[role];
			if (!member) continue;
			const digest = await hashFile(path.join(verificationDir, member.archiveName), false);
			assertInvariant(
				digest.size === member.size && digest.sha256 === member.sha256,
				`Backup member verification failed: ${member.archiveName}`,
			);
		}
	} finally {
		await fs.promises.rm(verificationDir, { recursive: true, force: true });
	}
}

export async function publishBackup(
	stage: string,
	backup: string,
	snapshot: PristineSnapshot,
	onLinked: () => void,
	onVerified: (checksum: StorageRepairChecksum) => void,
	afterLink?: () => void | Promise<void>,
	isWindows?: () => boolean,
	onDirectorySync?: () => void,
): Promise<StorageRepairChecksum> {
	const entries: Array<readonly [string, ArchiveMemberContent]> = [
		[BACKUP_MANIFEST_NAME, backupManifestJson(snapshot.manifest)],
	];
	for (const role of ["main", "wal", "shm"] as const) {
		const member = snapshot.manifest.members[role];
		const file = snapshot.paths[role];
		if (member && file) entries.push([member.archiveName, archiveFileMember(file, member.size)]);
	}
	await writeArchive(stage, "tar", entries);
	await fs.promises.chmod(stage, 0o600);
	await verifyBackup(stage, snapshot.manifest, new Set(entries.map(([name]) => name)), snapshot.tempDir);
	await syncFile(stage);
	const seal = await sealedFile(stage);
	const checksum = { path: backup, sha256: seal.sha256, size: Number(seal.size), ephemeral: false };
	await publishNoReplace(stage, backup, seal, onLinked, { afterLink, isWindows, onDirectorySync });
	onVerified(checksum);
	return checksum;
}

export function checkpointCandidate(candidate: string): void {
	const db = new Database(candidate);
	try {
		db.fileControl(sqliteConstants.SQLITE_FCNTL_PERSIST_WAL, 0);
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} finally {
		db.close();
	}
}

export function verifyCommonCandidate(candidate: string): void {
	const db = new Database(candidate, { readonly: true, safeIntegers: true });
	try {
		const integrity = db.prepare("PRAGMA integrity_check").values();
		assertInvariant(
			integrity.length === 1 && integrity[0]?.[0] === "ok",
			`Candidate integrity_check failed: ${stableJson(integrity)}`,
		);
		assertInvariant(db.prepare("PRAGMA foreign_key_check").all().length === 0, "Candidate foreign_key_check failed");
	} finally {
		db.close();
	}
}

export async function sealCandidate(candidate: string): Promise<PublishedFile> {
	await removeCandidateSidecars(candidate);
	await fs.promises.chmod(candidate, 0o600);
	await syncFile(candidate);
	return sealedFile(candidate);
}

export async function publishCandidate(
	stage: string,
	finalPath: string,
	seal: PublishedFile,
	onLinked: () => void,
	hooks: PublicationHooks = {},
): Promise<void> {
	await publishNoReplace(stage, finalPath, seal, onLinked, hooks);
}

export function manualNextStep(result: StorageRepairResult): string {
	if (result.status === "refused") {
		return "Repair was refused. Do not alter live storage or install the candidate.";
	}
	if (!result.apply && result.status === "ready") {
		return "Candidate is ready for publication. Rerun the same repair with --apply; do not alter live storage or install the candidate yet.";
	}
	if (result.status === "published-with-warning" || !result.candidatePathTrusted) {
		return `Do not install the candidate or alter live storage. Retain the candidate, backup tar ${result.backup}, and quarantine artifacts for diagnosis.`;
	}
	if (!(result.apply && result.status === "ready" && result.candidatePublished)) {
		return "Candidate is not ready for installation. Do not alter live storage or install the candidate.";
	}
	return [
		"Stop every OMP process.",
		`Move ${result.source}, ${result.source}-wal, and ${result.source}-shm together into a retained quarantine directory.`,
		"Verify no old sidecar remains at the live basename.",
		`Copy ${result.candidate} to an exclusively created mode-0600 sibling staging file, verify its checksum, fsync it, atomically no-replace-rename it to the now-vacant live main path, and sync the parent directory.`,
		`If manually restoring ${result.backup}, extract every source member and apply its manifest.json recorded uid, gid, and mode; if ownership cannot be restored, use mode 0600 for that member instead.`,
		`Keep the candidate, backup tar ${result.backup}, and quarantine until a normal reopen succeeds; the tar manifest documents byte-exact source restoration if needed. Never stream-copy directly into the live basename.`,
	].join(" ");
}
