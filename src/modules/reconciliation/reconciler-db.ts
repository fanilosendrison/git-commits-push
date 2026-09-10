/** Durable, bounded SQLite coordinator storage. */
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export {
	APPLICATION_STATE_DIRECTORY_NAME,
	NODE_CUTOVER_CLOSURE_LEDGER_FILE_NAME,
	RECONCILER_DB_FILE_NAME,
	RECONCILER_STATE_DIRECTORY_NAME,
	resolveApplicationStateDirectory,
	resolveNodeCutoverClosureLedgerPath,
	resolveReconcilerDbPath,
	resolveReconcilerStateDirectory,
} from "./reconciler-paths.ts";
export {
	type ActiveExecutionRecord,
	type ActiveExecutionState,
	POSIX_EXECUTION_BOUNDARY_KIND,
	ReconcilerInvariantError,
	type ReconcilerStateRecord,
	readReconcilerState,
} from "./reconciler-state.ts";

export const RECONCILER_SCHEMA_VERSION = 3;
export const RECONCILER_BUSY_TIMEOUT_MS = 5_000;
export const RECONCILER_STATE_TABLE = "reconciler_state";
export const RECONCILER_EXECUTION_COLUMN_DEFINITIONS = Object.freeze([
	"execution_token TEXT",
	"execution_generation INTEGER",
	"execution_pid INTEGER",
	"execution_process_identity TEXT",
	"execution_group_id INTEGER",
	"execution_boundary_kind TEXT",
	"execution_owner_token TEXT",
	"execution_state TEXT",
]);

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
	${RECONCILER_EXECUTION_COLUMN_DEFINITIONS.join(",\n\t")},
	CHECK (requested_generation >= completed_generation)
) STRICT;
`;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isSqliteBusy(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
		"errcode" in error &&
		(error as { errcode?: number }).errcode === 5
	);
}

function waitSynchronously(milliseconds: number): void {
	const signal = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(signal, 0, 0, milliseconds);
}

function enableWalWithBoundedContentionRetry(db: DatabaseSync): void {
	for (let attempt = 0; attempt < 8; attempt++) {
		try {
			db.exec("PRAGMA journal_mode = WAL");
			return;
		} catch (error) {
			if (!isSqliteBusy(error) || attempt === 7) throw error;
			waitSynchronously(10 * (attempt + 1));
		}
	}
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
		const migrationDetail =
			userVersion === 2
				? " Schema version 2 has no durable active-execution identity and cannot be reinterpreted safely. Perform the documented offline migration only after proving that no old execution tree survives."
				: "";
		throw new ReconcilerOpenError(
			"incompatible-schema",
			`Reconciler database at ${dbPath} declares schema version ${userVersion}, ` +
				`but this runtime only supports version ${RECONCILER_SCHEMA_VERSION}.${migrationDetail} ` +
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

/** Open or initialize the fail-closed singleton coordinator database. */
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
		if (!options.readOnly) enableWalWithBoundedContentionRetry(db);
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
					// Preserve the initialization error.
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
