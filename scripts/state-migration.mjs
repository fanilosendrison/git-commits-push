import { existsSync, lstatSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import {
	openReconcilerDb,
	readReconcilerState,
	resolveReconcilerDbPath,
} from "../src/modules/reconciliation/reconciler-db.ts";
import { inspectReconciliationPreflightState } from "../src/modules/reconciliation/reconciler-preflight.ts";
import {
	acquireStateCutoverLock,
	releaseStateCutoverLock,
} from "./state-cutover-lock.mjs";

const SQLITE_TRANSIENT_SUFFIXES = ["-journal", "-shm", "-wal"];

function requireStateDirectory(directoryPath, label) {
	if (!path.isAbsolute(directoryPath)) {
		throw new Error(`${label} must be an absolute path.`);
	}
	if (!existsSync(directoryPath)) return;
	const stats = lstatSync(directoryPath);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`${label} must be a physical directory: ${directoryPath}`);
	}
}

function assertIdleReconcilerState(db) {
	const state = readReconcilerState(db);
	if (state.ownerToken !== null || state.ownerPid !== null) {
		throw new Error(
			`Cannot migrate state while reconciler owner pid ${String(state.ownerPid)} is recorded.`,
		);
	}
	if (state.requestedGeneration !== state.completedGeneration) {
		throw new Error(
			`Cannot migrate pending reconciliation generations ${state.completedGeneration}/${state.requestedGeneration}.`,
		);
	}
}

function checkpointReconcilerDatabase(orderStateDirectory) {
	const dbPath = resolveReconcilerDbPath(orderStateDirectory);
	if (!existsSync(dbPath)) return;
	const dbStats = lstatSync(dbPath);
	if (!dbStats.isFile() || dbStats.isSymbolicLink() || dbStats.size === 0) {
		throw new Error(
			`Cannot migrate an uninitialized or non-regular reconciler database: ${dbPath}`,
		);
	}

	const verificationDb = openReconcilerDb(dbPath, { readOnly: true });
	try {
		assertIdleReconcilerState(verificationDb);
	} finally {
		verificationDb.close();
	}

	const db = openReconcilerDb(dbPath);
	try {
		assertIdleReconcilerState(db);
		const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
		if (
			typeof checkpoint !== "object" ||
			checkpoint === null ||
			!("busy" in checkpoint) ||
			checkpoint.busy !== 0
		) {
			throw new Error("SQLite refused to checkpoint reconciler state.");
		}
	} finally {
		db.close();
	}
	const transientFiles = SQLITE_TRANSIENT_SUFFIXES.map(
		(suffix) => `${dbPath}${suffix}`,
	).filter(existsSync);
	if (transientFiles.length > 0) {
		throw new Error(
			`SQLite transient files remain after checkpoint: ${transientFiles.map(path.basename).join(", ")}.`,
		);
	}
}

function validateMigratedState(targetRoot) {
	const orderStateDirectory = path.join(targetRoot, "orders");
	if (!existsSync(orderStateDirectory)) return;
	const blockers = inspectReconciliationPreflightState(
		orderStateDirectory,
		Date.now(),
	);
	if (blockers.length > 0) {
		throw new Error(
			`Migrated reconciler state failed preflight: ${blockers.map((blocker) => `${blocker.kind}: ${blocker.detail}`).join("; ")}`,
		);
	}
}

export function migrateApplicationState({ sourceRoot, targetRoot }) {
	if (!path.isAbsolute(sourceRoot)) {
		throw new Error("Legacy state root must be an absolute path.");
	}
	const lockPath = acquireStateCutoverLock(targetRoot);
	let rollbackRequired = false;
	try {
		requireStateDirectory(sourceRoot, "Legacy state root");
		requireStateDirectory(targetRoot, "Target state root");
		if (!existsSync(sourceRoot)) {
			return {
				outcome: existsSync(targetRoot) ? "already-migrated" : "absent",
			};
		}
		if (existsSync(targetRoot)) {
			throw new Error(
				`Legacy and target state roots both exist; refusing divergent state: ${sourceRoot} and ${targetRoot}`,
			);
		}

		checkpointReconcilerDatabase(path.join(sourceRoot, "orders"));
		try {
			renameSync(sourceRoot, targetRoot);
			rollbackRequired = true;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EXDEV") {
				throw new Error(
					"State migration requires source and target to be on the same filesystem.",
					{ cause: error },
				);
			}
			throw error;
		}
		try {
			validateMigratedState(targetRoot);
		} catch (error) {
			renameSync(targetRoot, sourceRoot);
			rollbackRequired = false;
			throw error;
		}
		rollbackRequired = false;
		return {
			outcome: "migrated",
			entries: readdirSync(targetRoot).sort(),
		};
	} finally {
		if (rollbackRequired && existsSync(targetRoot) && !existsSync(sourceRoot)) {
			try {
				renameSync(targetRoot, sourceRoot);
			} catch {
				// The original error remains authoritative; manual recovery is required.
			}
		}
		releaseStateCutoverLock(lockPath);
	}
}
