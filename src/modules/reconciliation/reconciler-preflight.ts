/**
 * src/modules/reconciliation/reconciler-preflight.ts — Read-only classification
 * of the durable reconciliation state for the node-cutover preflight gate.
 *
 * Never creates, mutates or deletes anything. An absent database is ready;
 * legacy queue residue stays explicitly detectable until migrated.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	inspectLegacyQueueState,
	LEGACY_LOCK_FILE_NAME,
} from "./legacy-queue-state.ts";
import {
	openReconcilerDb,
	ReconcilerInvariantError,
	ReconcilerOpenError,
	readReconcilerState,
	resolveReconcilerDbPath,
} from "./reconciler-db.ts";

export type ReconcilerPreflightBlockerKind =
	| "live-queue-lock"
	| "stale-queue-lock"
	| "malformed-queue-lock"
	| "pending-order"
	| "unreadable-order-state"
	| "active-reconciler"
	| "pending-reconciliation"
	| "uncheckpointed-reconciler-db"
	| "corrupt-reconciler-db"
	| "incompatible-reconciler-db";

export interface ReconcilerPreflightBlocker {
	readonly detail: string;
	readonly kind: ReconcilerPreflightBlockerKind;
	readonly subject: string;
}

const SQLITE_TRANSIENT_FILE_SUFFIXES = ["-journal", "-shm", "-wal"] as const;

function listSqliteTransientFiles(dbPath: string): string[] {
	return SQLITE_TRANSIENT_FILE_SUFFIXES.map((suffix) => `${dbPath}${suffix}`)
		.filter((candidate) => {
			try {
				return fs.lstatSync(candidate, { throwIfNoEntry: false }) !== undefined;
			} catch {
				// An inaccessible sidecar path is not evidence of absence.
				return true;
			}
		})
		.sort();
}

function readDatabaseFingerprint(dbPath: string): string {
	const stat = fs.statSync(dbPath, { bigint: true });
	return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function uncheckpointedDatabaseBlocker(
	transientFiles: readonly string[],
): ReconcilerPreflightBlocker {
	const detail =
		transientFiles.length > 0
			? `SQLite transient state is present (${transientFiles.map((filePath) => path.basename(filePath)).join(", ")}); refusing a potentially stale immutable read`
			: "reconciler database changed during immutable inspection";
	return {
		detail,
		kind: "uncheckpointed-reconciler-db",
		subject: "reconciler.sqlite",
	};
}

function legacyLockBlocker(
	lock: "live" | "stale" | "malformed",
): ReconcilerPreflightBlocker {
	if (lock === "live") {
		return {
			detail: "legacy queue lock heartbeat is still live",
			kind: "live-queue-lock",
			subject: LEGACY_LOCK_FILE_NAME,
		};
	}
	if (lock === "stale") {
		return {
			detail: "stale legacy queue lock must be migrated before cutover",
			kind: "stale-queue-lock",
			subject: LEGACY_LOCK_FILE_NAME,
		};
	}
	return {
		detail: "legacy queue lock is malformed or unreadable",
		kind: "malformed-queue-lock",
		subject: LEGACY_LOCK_FILE_NAME,
	};
}

/**
 * Classify the reconciliation state directory. Read-only; no files are
 * created. Blockers are emitted for legacy queue residue, an active
 * reconciler owner, pending unreconciled generations, and corrupt or
 * incompatible databases.
 */
export function inspectReconciliationPreflightState(
	stateDirectory: string,
	nowEpochMs: number,
): readonly ReconcilerPreflightBlocker[] {
	const blockers: ReconcilerPreflightBlocker[] = [];

	let legacy: ReturnType<typeof inspectLegacyQueueState>;
	try {
		legacy = inspectLegacyQueueState(stateDirectory, nowEpochMs);
	} catch (error) {
		return [
			{
				detail: `order state directory is unreadable: ${error instanceof Error ? error.message : String(error)}`,
				kind: "unreadable-order-state",
				subject: "order-state",
			},
		];
	}

	if (legacy.lock !== "none") {
		blockers.push(legacyLockBlocker(legacy.lock));
	}
	for (const artifactPath of legacy.orderArtifactPaths) {
		blockers.push({
			detail: "legacy queued order artifact must be migrated before cutover",
			kind: "pending-order",
			subject: path.basename(artifactPath),
		});
	}

	const dbPath = resolveReconcilerDbPath(stateDirectory);
	let databaseStat: fs.Stats | undefined;
	try {
		databaseStat = fs.statSync(dbPath, { throwIfNoEntry: false });
	} catch (error) {
		blockers.push({
			detail: `reconciler database cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
			kind: "corrupt-reconciler-db",
			subject: "reconciler.sqlite",
		});
		return blockers;
	}
	if (!databaseStat) return blockers;
	if (!databaseStat.isFile()) {
		blockers.push({
			detail: "reconciler database path is not a regular file",
			kind: "corrupt-reconciler-db",
			subject: "reconciler.sqlite",
		});
		return blockers;
	}

	const transientFilesBefore = listSqliteTransientFiles(dbPath);
	if (transientFilesBefore.length > 0) {
		blockers.push(uncheckpointedDatabaseBlocker(transientFilesBefore));
		return blockers;
	}

	let fingerprintBefore: string;
	try {
		fingerprintBefore = readDatabaseFingerprint(dbPath);
	} catch (error) {
		blockers.push({
			detail: `reconciler database cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
			kind: "corrupt-reconciler-db",
			subject: "reconciler.sqlite",
		});
		return blockers;
	}

	const databaseBlockers: ReconcilerPreflightBlocker[] = [];
	try {
		const db = openReconcilerDb(dbPath, { readOnly: true });
		try {
			const state = readReconcilerState(db);
			if (state.ownerToken !== null && state.ownerPid !== null) {
				databaseBlockers.push({
					detail: `reconciliation owner is active (pid ${state.ownerPid}, generation ${String(state.runningGeneration)})`,
					kind: "active-reconciler",
					subject: "reconciler.sqlite",
				});
			} else if (state.requestedGeneration > state.completedGeneration) {
				databaseBlockers.push({
					detail: `reconciliation is pending (requested ${state.requestedGeneration} > completed ${state.completedGeneration}) with no active owner`,
					kind: "pending-reconciliation",
					subject: "reconciler.sqlite",
				});
			}
		} finally {
			db.close();
		}
	} catch (error) {
		if (error instanceof ReconcilerOpenError) {
			if (error.kind === "missing") {
				blockers.push(uncheckpointedDatabaseBlocker([]));
				return blockers;
			}
			blockers.push({
				detail: error.message,
				kind:
					error.kind === "incompatible-schema"
						? "incompatible-reconciler-db"
						: "corrupt-reconciler-db",
				subject: "reconciler.sqlite",
			});
			return blockers;
		}
		if (error instanceof ReconcilerInvariantError) {
			blockers.push({
				detail: error.message,
				kind: "corrupt-reconciler-db",
				subject: "reconciler.sqlite",
			});
			return blockers;
		}
		blockers.push({
			detail: `reconciler database read failed: ${error instanceof Error ? error.message : String(error)}`,
			kind: "corrupt-reconciler-db",
			subject: "reconciler.sqlite",
		});
		return blockers;
	}

	const transientFilesAfter = listSqliteTransientFiles(dbPath);
	let fingerprintAfter: string | null = null;
	try {
		fingerprintAfter = readDatabaseFingerprint(dbPath);
	} catch {
		// A removed or replaced database is an unstable inspection, not readiness.
	}
	if (
		transientFilesAfter.length > 0 ||
		fingerprintAfter !== fingerprintBefore
	) {
		blockers.push(uncheckpointedDatabaseBlocker(transientFilesAfter));
		return blockers;
	}
	blockers.push(...databaseBlockers);
	return blockers;
}
