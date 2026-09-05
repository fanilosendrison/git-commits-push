/**
 * src/modules/reconciliation/reconciler-db.ts — Durable SQLite coordinator state.
 *
 * Single source of truth for the global reconciliation database. The database
 * holds exactly one singleton application row and accumulates NO history:
 * no per-request orders, no run log, no event table.
 *
 * Fail-closed contract: corrupted databases, incompatible schema versions and
 * impossible invariant states raise typed errors and are never auto-deleted or
 * silently reset.
 */
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export {
	RECONCILER_DB_FILE_NAME,
	resolveReconcilerDbPath,
	resolveReconcilerStateDirectory,
} from "./reconciler-paths.ts";
export const RECONCILER_SCHEMA_VERSION = 2;
export const RECONCILER_BUSY_TIMEOUT_MS = 5_000;
export const RECONCILER_STATE_TABLE = "reconciler_state";

export type ReconcilerOpenErrorKind =
	| "missing"
	| "corrupt"
	| "incompatible-schema";

export class ReconcilerOpenError extends Error {
	readonly kind: ReconcilerOpenErrorKind;

	constructor(
		kind: ReconcilerOpenErrorKind,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ReconcilerOpenError";
		this.kind = kind;
	}
}

export class ReconcilerInvariantError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ReconcilerInvariantError";
	}
}

export interface ReconcilerStateRecord {
	readonly singletonId: number;
	readonly requestedGeneration: number;
	readonly completedGeneration: number;
	readonly runningGeneration: number | null;
	readonly ownerToken: string | null;
	readonly ownerPid: number | null;
	readonly ownerBootEpochMs: number | null;
	readonly ownerProcessIdentity: string | null;
	readonly ownerCallerName: string | null;
	readonly ownerOriginAgent: string | null;
	readonly ownerSessionId: string | null;
	readonly heartbeatAtEpochMs: number | null;
}

export interface OpenReconcilerDbOptions {
	readonly readOnly?: boolean;
}

const CREATE_STATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS reconciler_state (
	singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
	requested_generation INTEGER NOT NULL,
	completed_generation INTEGER NOT NULL,
	running_generation INTEGER,
	owner_token TEXT,
	owner_pid INTEGER,
	owner_boot_epoch_ms INTEGER,
	owner_process_identity TEXT,
	owner_caller_name TEXT,
	owner_origin_agent TEXT,
	owner_session_id TEXT,
	heartbeat_at_epoch_ms INTEGER,
	CHECK (requested_generation >= completed_generation)
) STRICT;
`;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readSchemaVersion(db: DatabaseSync): number {
	const versionRow = db.prepare("PRAGMA user_version").get() as {
		user_version?: number;
	};
	return Number(versionRow?.user_version ?? 0);
}

function assertCompatibleSchema(
	dbPath: string,
	userVersion: number,
	tables: readonly string[],
): void {
	if (userVersion !== RECONCILER_SCHEMA_VERSION) {
		throw new ReconcilerOpenError(
			"incompatible-schema",
			`Reconciler database at ${dbPath} declares schema version ${userVersion}, ` +
				`but this runtime only supports version ${RECONCILER_SCHEMA_VERSION}. ` +
				"Refusing to start Git mutations while coordinator state cannot be trusted.",
		);
	}
	if (!tables.includes(RECONCILER_STATE_TABLE)) {
		throw new ReconcilerOpenError(
			"corrupt",
			`Reconciler database at ${dbPath} declares schema version ${RECONCILER_SCHEMA_VERSION} ` +
				"but the reconciler_state table is missing. The database is preserved; inspect it manually.",
		);
	}
}

export function listReconcilerTables(db: DatabaseSync): string[] {
	const rows = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all() as Array<{ name: string }>;
	return rows.map((row) => row.name);
}

export function countReconcilerStateRows(db: DatabaseSync): number {
	const row = db
		.prepare("SELECT COUNT(*) AS n FROM reconciler_state")
		.get() as { n: number };
	return row.n;
}

/**
 * Open the reconciler database. Write mode initializes the singleton state on
 * first use; read-only mode never creates or mutates anything and reports
 * zero rows for a database that does not exist yet.
 */
export function openReconcilerDb(
	dbPath: string,
	options: OpenReconcilerDbOptions = {},
): DatabaseSync {
	if (options.readOnly) {
		let databaseStat: fs.Stats | undefined;
		try {
			databaseStat = fs.statSync(dbPath, { throwIfNoEntry: false });
		} catch (error) {
			throw new ReconcilerOpenError(
				"corrupt",
				`Reconciler database cannot be inspected at ${dbPath}: ${errorMessage(error)}.`,
				{ cause: error },
			);
		}
		if (!databaseStat) {
			// Read-only inspection must never create the database.
			throw new ReconcilerOpenError(
				"missing",
				`Reconciler database does not exist at ${dbPath}; no durable reconciliation state is present.`,
			);
		}
		if (!databaseStat.isFile()) {
			throw new ReconcilerOpenError(
				"corrupt",
				`Reconciler database path is not a regular file: ${dbPath}.`,
			);
		}
	}
	let db: DatabaseSync;
	try {
		if (options.readOnly) {
			const immutableLocation = pathToFileURL(dbPath);
			immutableLocation.searchParams.set("immutable", "1");
			db = new DatabaseSync(immutableLocation, { readOnly: true });
		} else {
			db = new DatabaseSync(dbPath);
		}
	} catch (error) {
		throw new ReconcilerOpenError(
			"corrupt",
			`Reconciler database cannot be opened at ${dbPath}: ${errorMessage(error)}. ` +
				"The file is preserved. Inspect it and remove it manually only after confirming no reconciliation is pending.",
			{ cause: error },
		);
	}

	try {
		db.exec(`PRAGMA busy_timeout = ${RECONCILER_BUSY_TIMEOUT_MS}`);
		if (!options.readOnly) {
			db.exec("PRAGMA journal_mode = WAL");
		}
		const userVersion = readSchemaVersion(db);
		const tables = listReconcilerTables(db);

		if (userVersion === 0 && tables.length === 0) {
			if (options.readOnly) {
				throw new ReconcilerOpenError(
					"corrupt",
					`Reconciler database at ${dbPath} exists but has no initialized schema.`,
				);
			}
			db.exec("BEGIN IMMEDIATE");
			try {
				const lockedVersion = readSchemaVersion(db);
				const lockedTables = listReconcilerTables(db);
				if (lockedVersion === 0 && lockedTables.length === 0) {
					db.exec(CREATE_STATE_TABLE_SQL);
					db.exec(
						"INSERT INTO reconciler_state (singleton_id, requested_generation, completed_generation) VALUES (1, 0, 0)",
					);
					db.exec(`PRAGMA user_version = ${RECONCILER_SCHEMA_VERSION}`);
				} else {
					assertCompatibleSchema(dbPath, lockedVersion, lockedTables);
				}
				db.exec("COMMIT");
			} catch (error) {
				try {
					db.exec("ROLLBACK");
				} catch {
					// Preserve the initialization error when rollback is no longer possible.
				}
				throw error;
			}
			return db;
		}
		assertCompatibleSchema(dbPath, userVersion, tables);
		return db;
	} catch (error) {
		try {
			db.close();
		} catch {
			// Connection already unusable.
		}
		if (error instanceof ReconcilerOpenError) throw error;
		throw new ReconcilerOpenError(
			"corrupt",
			`Reconciler database at ${dbPath} failed schema initialization: ${errorMessage(error)}. ` +
				"The database is preserved; inspect it manually.",
			{ cause: error },
		);
	}
}

interface RawStateRow {
	readonly singleton_id: number;
	readonly requested_generation: number;
	readonly completed_generation: number;
	readonly running_generation: number | null;
	readonly owner_token: string | null;
	readonly owner_pid: number | null;
	readonly owner_boot_epoch_ms: number | null;
	readonly owner_process_identity: string | null;
	readonly owner_caller_name: string | null;
	readonly owner_origin_agent: string | null;
	readonly owner_session_id: string | null;
	readonly heartbeat_at_epoch_ms: number | null;
}

function isSafeNonNegativeInteger(value: number | null): boolean {
	return value !== null && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Read and validate the singleton state row. Any deviation from the state
 * invariants raises {@link ReconcilerInvariantError} — fail closed.
 */
export function readReconcilerState(db: DatabaseSync): ReconcilerStateRecord {
	const rows = db
		.prepare(
			`SELECT singleton_id, requested_generation, completed_generation,
				running_generation, owner_token, owner_pid, owner_boot_epoch_ms,
				owner_process_identity, owner_caller_name, owner_origin_agent, owner_session_id,
				heartbeat_at_epoch_ms
			 FROM reconciler_state`,
		)
		.all() as unknown as RawStateRow[];

	if (rows.length !== 1) {
		throw new ReconcilerInvariantError(
			`reconciler_state must contain exactly one row, found ${rows.length}`,
		);
	}
	const row = rows[0] as RawStateRow;
	if (row.singleton_id !== 1) {
		throw new ReconcilerInvariantError(
			`reconciler_state singleton_id must be 1, found ${row.singleton_id}`,
		);
	}
	if (!isSafeNonNegativeInteger(row.requested_generation)) {
		throw new ReconcilerInvariantError(
			`reconciler_state requested_generation is invalid: ${String(row.requested_generation)}`,
		);
	}
	if (!isSafeNonNegativeInteger(row.completed_generation)) {
		throw new ReconcilerInvariantError(
			`reconciler_state completed_generation is invalid: ${String(row.completed_generation)}`,
		);
	}
	if (row.requested_generation < row.completed_generation) {
		throw new ReconcilerInvariantError(
			`requested_generation (${row.requested_generation}) must be >= completed_generation (${row.completed_generation})`,
		);
	}

	const hasRunning = row.running_generation !== null;
	const ownerFieldsArePresent = [
		row.owner_token,
		row.owner_pid,
		row.owner_boot_epoch_ms,
		row.owner_process_identity,
		row.owner_caller_name,
		row.owner_origin_agent,
	].map((value) => value !== null);
	if (ownerFieldsArePresent.some((isPresent) => isPresent !== hasRunning)) {
		throw new ReconcilerInvariantError(
			"owner token, pid, boot epoch, process identity, caller, origin and running generation must be set and cleared together",
		);
	}
	if (!hasRunning && row.owner_session_id !== null) {
		throw new ReconcilerInvariantError(
			"owner session id must be cleared when no owner is active",
		);
	}

	if (hasRunning) {
		if (
			!isSafeNonNegativeInteger(row.running_generation) ||
			row.running_generation <= row.completed_generation ||
			row.running_generation > row.requested_generation
		) {
			throw new ReconcilerInvariantError(
				`running_generation (${String(row.running_generation)}) must be > completed_generation (${row.completed_generation}) and <= requested_generation (${row.requested_generation})`,
			);
		}
		if (!isSafeNonNegativeInteger(row.owner_boot_epoch_ms)) {
			throw new ReconcilerInvariantError(
				"owner_boot_epoch_ms must be a finite non-negative integer while an owner is active",
			);
		}
		if (!isSafeNonNegativeInteger(row.owner_pid) || row.owner_pid === 0) {
			throw new ReconcilerInvariantError(
				"owner_pid must be a positive integer while an owner is active",
			);
		}
		if (
			!isSafeNonNegativeInteger(row.heartbeat_at_epoch_ms) ||
			row.owner_token?.length === 0 ||
			row.owner_process_identity?.trim().length === 0 ||
			row.owner_caller_name?.trim().length === 0 ||
			row.owner_origin_agent?.trim().length === 0 ||
			row.owner_session_id?.trim().length === 0
		) {
			throw new ReconcilerInvariantError(
				"active owner metadata must contain a heartbeat and non-empty identity fields",
			);
		}
	} else if (row.heartbeat_at_epoch_ms !== null) {
		throw new ReconcilerInvariantError(
			"heartbeat_at_epoch_ms must be cleared when no owner is active",
		);
	}

	return {
		singletonId: row.singleton_id,
		requestedGeneration: row.requested_generation,
		completedGeneration: row.completed_generation,
		runningGeneration: row.running_generation,
		ownerToken: row.owner_token,
		ownerPid: row.owner_pid,
		ownerBootEpochMs: row.owner_boot_epoch_ms,
		ownerProcessIdentity: row.owner_process_identity,
		ownerCallerName: row.owner_caller_name,
		ownerOriginAgent: row.owner_origin_agent,
		ownerSessionId: row.owner_session_id,
		heartbeatAtEpochMs: row.heartbeat_at_epoch_ms,
	};
}
