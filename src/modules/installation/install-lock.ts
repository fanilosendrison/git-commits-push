import { randomBytes } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	isProcessAlive,
	readProcessStartIdentity,
} from "../reconciliation/reconciler.ts";

const INSTALL_LOCK_RECORD_KEYS = [
	"nonce",
	"pid",
	"processIdentity",
	"version",
] as const;
const MAX_LOCK_RECORD_BYTES = 4_096;

interface InstallLockRecord {
	readonly version: 1;
	readonly nonce: string;
	readonly pid: number;
	readonly processIdentity: string;
}

export interface InstallLockOwner extends InstallLockRecord {
	readonly database: DatabaseSync;
	readonly recovered: boolean;
}

let currentProcessIdentity: string | null | undefined;

function resolveCurrentProcessIdentity(): string {
	if (currentProcessIdentity === undefined) {
		currentProcessIdentity = readProcessStartIdentity(process.pid);
	}
	if (currentProcessIdentity === null) {
		throw new Error("Cannot establish the installer process-start identity.");
	}
	return currentProcessIdentity;
}

function hasExpectedOwner(uid: number): boolean {
	return process.getuid === undefined || uid === process.getuid();
}

function isInstallLockRecord(value: unknown): value is InstallLockRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Partial<InstallLockRecord>;
	const keys = Object.keys(value).sort();
	return (
		keys.length === INSTALL_LOCK_RECORD_KEYS.length &&
		INSTALL_LOCK_RECORD_KEYS.every((key, index) => keys[index] === key) &&
		candidate.version === 1 &&
		typeof candidate.nonce === "string" &&
		/^[a-f0-9]{32}$/.test(candidate.nonce) &&
		typeof candidate.pid === "number" &&
		Number.isSafeInteger(candidate.pid) &&
		candidate.pid > 0 &&
		typeof candidate.processIdentity === "string" &&
		candidate.processIdentity.length > 0 &&
		candidate.processIdentity.length <= 2_048
	);
}

function ownerRecordPath(lockPath: string): string {
	return `${lockPath}.owner`;
}

function readOwnerRecord(lockPath: string): InstallLockRecord {
	const recordPath = ownerRecordPath(lockPath);
	const stats = lstatSync(recordPath);
	if (
		!stats.isFile() ||
		stats.isSymbolicLink() ||
		(stats.mode & 0o777) !== 0o600 ||
		stats.size <= 0 ||
		stats.size > MAX_LOCK_RECORD_BYTES ||
		!hasExpectedOwner(stats.uid)
	) {
		throw new Error(
			`Install lock owner is not a private physical file: ${recordPath}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(recordPath, "utf8"));
	} catch (error) {
		throw new Error(`Install lock owner is malformed: ${recordPath}`, {
			cause: error,
		});
	}
	if (!isInstallLockRecord(parsed)) {
		throw new Error(`Install lock has an invalid owner record: ${recordPath}`);
	}
	return parsed;
}

function pathExists(candidate: string): boolean {
	try {
		lstatSync(candidate);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function ensureLockDatabaseFile(lockPath: string): void {
	try {
		const descriptor = openSync(lockPath, "wx", 0o600);
		try {
			fchmodSync(descriptor, 0o600);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const stats = lstatSync(lockPath);
	if (
		!stats.isFile() ||
		stats.isSymbolicLink() ||
		(stats.mode & 0o777) !== 0o600 ||
		!hasExpectedOwner(stats.uid)
	) {
		throw new Error(
			`Install lock must be a private physical file: ${lockPath}`,
		);
	}
}

function isSqliteBusy(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const candidate = error as Error & { readonly errcode?: number };
	return (
		candidate.errcode === 5 ||
		/database is (?:busy|locked)/i.test(error.message)
	);
}

function ownerIsLive(owner: InstallLockRecord): boolean {
	if (!isProcessAlive(owner.pid)) return false;
	const observedIdentity = readProcessStartIdentity(owner.pid);
	return (
		observedIdentity === null || observedIdentity === owner.processIdentity
	);
}

function activeInstallerMessage(lockPath: string): string {
	try {
		const owner = readOwnerRecord(lockPath);
		return `A git-commits-push installer is active (pid ${String(owner.pid)}).`;
	} catch {
		return "A git-commits-push installer is active.";
	}
}

function rollbackAndClose(database: DatabaseSync): void {
	try {
		database.exec("ROLLBACK");
	} catch {
		// Closing still releases the operating-system lock after a failed rollback.
	}
	database.close();
}

function removeStaleOwnerCandidates(lockPath: string): void {
	const directory = path.dirname(lockPath);
	const prefix = `${path.basename(ownerRecordPath(lockPath))}.candidate-`;
	for (const name of readdirSync(directory)) {
		if (!name.startsWith(prefix)) continue;
		const nonce = name.slice(prefix.length);
		if (!/^[a-f0-9]{32}$/.test(nonce)) continue;
		unlinkSync(path.join(directory, name));
	}
}

function archiveStaleOwnerRecord(lockPath: string, nonce: string): boolean {
	const recordPath = ownerRecordPath(lockPath);
	if (!pathExists(recordPath)) return false;
	const existingOwner = readOwnerRecord(lockPath);
	if (ownerIsLive(existingOwner)) {
		throw new Error(
			`Install lock owner metadata still identifies a live process (pid ${String(existingOwner.pid)}).`,
		);
	}
	renameSync(recordPath, `${recordPath}.stale-${Date.now()}-${nonce}`);
	return true;
}

function writeOwnerRecord(lockPath: string, owner: InstallLockRecord): void {
	const recordPath = ownerRecordPath(lockPath);
	const candidatePath = `${recordPath}.candidate-${owner.nonce}`;
	const descriptor = openSync(candidatePath, "wx", 0o600);
	try {
		writeFileSync(descriptor, JSON.stringify(owner), "utf8");
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	try {
		linkSync(candidatePath, recordPath);
	} finally {
		unlinkSync(candidatePath);
	}
}

/** Acquire the global installer lock through a lifecycle-held SQLite transaction. */
export function acquireInstallLock(lockPath: string): InstallLockOwner {
	if (!path.isAbsolute(lockPath)) {
		throw new Error("Install lock path must be absolute.");
	}
	ensureLockDatabaseFile(lockPath);
	const database = new DatabaseSync(lockPath);
	try {
		database.exec(
			"PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE; " +
				"CREATE TABLE IF NOT EXISTS install_lock_schema (version INTEGER NOT NULL);",
		);
	} catch (error) {
		database.close();
		if (isSqliteBusy(error)) {
			throw new Error(activeInstallerMessage(lockPath), { cause: error });
		}
		throw new Error(`Cannot acquire the installer lock database: ${lockPath}`, {
			cause: error,
		});
	}
	const nonce = randomBytes(16).toString("hex");
	const owner: InstallLockRecord = {
		nonce,
		pid: process.pid,
		processIdentity: resolveCurrentProcessIdentity(),
		version: 1,
	};
	let recovered = false;
	try {
		removeStaleOwnerCandidates(lockPath);
		recovered = archiveStaleOwnerRecord(lockPath, nonce);
		writeOwnerRecord(lockPath, owner);
	} catch (error) {
		rollbackAndClose(database);
		throw error;
	}
	return { ...owner, database, recovered };
}

/** Release the SQLite lock only while its durable owner record still matches. */
export function releaseInstallLock(
	lockPath: string,
	owner: InstallLockOwner,
): void {
	const currentOwner = readOwnerRecord(lockPath);
	if (
		currentOwner.nonce !== owner.nonce ||
		currentOwner.pid !== owner.pid ||
		currentOwner.processIdentity !== owner.processIdentity
	) {
		throw new Error("Install lock ownership changed before release.");
	}
	unlinkSync(ownerRecordPath(lockPath));
	let commitError: unknown;
	try {
		owner.database.exec("COMMIT");
	} catch (error) {
		commitError = error;
	}
	try {
		owner.database.close();
	} catch (error) {
		if (commitError === undefined) commitError = error;
	}
	if (commitError !== undefined) throw commitError;
}
