import { existsSync, lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
	openReconcilerDb,
	RECONCILER_EXECUTION_COLUMN_DEFINITIONS,
	RECONCILER_SCHEMA_VERSION,
	readReconcilerState,
} from "../src/modules/reconciliation/reconciler-db.ts";

const SQLITE_SIDECAR_SUFFIXES = ["-journal", "-shm", "-wal"];
const V2_OWNER_FIELDS = [
	"running_generation",
	"owner_token",
	"owner_pid",
	"owner_boot_epoch_ms",
	"owner_process_identity",
	"owner_caller_name",
	"owner_origin_agent",
	"owner_session_id",
	"heartbeat_at_epoch_ms",
];

function readUserVersion(db) {
	return Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
}

function assertRegularCheckpointedDatabase(dbPath) {
	if (!existsSync(dbPath))
		throw new Error(`Reconciler database is absent: ${dbPath}`);
	const stats = lstatSync(dbPath);
	if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0) {
		throw new Error(
			`Reconciler database must be a non-empty regular file: ${dbPath}`,
		);
	}
	const sidecars = SQLITE_SIDECAR_SUFFIXES.map(
		(suffix) => `${dbPath}${suffix}`,
	).filter(existsSync);
	if (sidecars.length > 0) {
		throw new Error(
			`Reconciler database has uncheckpointed SQLite sidecars: ${sidecars.join(", ")}`,
		);
	}
}

function assertIdleConvergedV2State(db) {
	const rows = db.prepare("SELECT * FROM reconciler_state").all();
	if (rows.length !== 1 || rows[0]?.singleton_id !== 1) {
		throw new Error("Schema-v2 reconciler state is not one singleton row.");
	}
	const row = rows[0];
	if (
		!Number.isSafeInteger(row.requested_generation) ||
		!Number.isSafeInteger(row.completed_generation) ||
		row.requested_generation < 0 ||
		row.requested_generation !== row.completed_generation
	) {
		throw new Error(
			"Schema-v2 migration requires requested_generation to equal completed_generation.",
		);
	}
	if (V2_OWNER_FIELDS.some((field) => row[field] !== null)) {
		throw new Error(
			"Schema-v2 migration requires an idle row with no recorded owner or running generation.",
		);
	}
}

/**
 * Upgrade only an explicitly confirmed, idle schema-v2 singleton in place.
 * The confirmation records an operator proof external to v2: no old execution
 * tree remains alive. Active or pending v2 state is never guessed safe.
 */
export function migrateReconcilerV2Database({
	dbPath,
	confirmedNoLiveExecution,
}) {
	if (confirmedNoLiveExecution !== true) {
		throw new Error(
			"Schema-v2 migration requires explicit confirmation that no launcher, supervisor, or descendant execution remains alive.",
		);
	}
	assertRegularCheckpointedDatabase(dbPath);
	const db = new DatabaseSync(dbPath);
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		const version = readUserVersion(db);
		if (version === RECONCILER_SCHEMA_VERSION) {
			readReconcilerState(db);
			return { outcome: "already-current" };
		}
		if (version !== 2) {
			throw new Error(
				`Only reconciler schema version 2 can be migrated; found ${version}.`,
			);
		}
		db.exec("BEGIN IMMEDIATE");
		try {
			if (readUserVersion(db) !== 2) {
				throw new Error(
					"Reconciler schema changed during migration admission.",
				);
			}
			assertIdleConvergedV2State(db);
			for (const definition of RECONCILER_EXECUTION_COLUMN_DEFINITIONS) {
				db.exec(`ALTER TABLE reconciler_state ADD COLUMN ${definition}`);
			}
			db.exec(`PRAGMA user_version = ${RECONCILER_SCHEMA_VERSION}`);
			db.exec("COMMIT");
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// Preserve the migration failure.
			}
			throw error;
		}
	} finally {
		db.close();
	}
	const verified = openReconcilerDb(dbPath, { readOnly: true });
	try {
		const state = readReconcilerState(verified);
		if (state.activeExecution !== null) {
			throw new Error(
				"Migrated reconciler unexpectedly contains execution state.",
			);
		}
	} finally {
		verified.close();
	}
	return { outcome: "migrated" };
}
