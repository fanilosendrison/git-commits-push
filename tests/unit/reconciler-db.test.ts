import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	countReconcilerStateRows,
	listReconcilerTables,
	openReconcilerDb,
	RECONCILER_DB_FILE_NAME,
	RECONCILER_SCHEMA_VERSION,
	ReconcilerInvariantError,
	ReconcilerOpenError,
	readReconcilerState,
	resolveApplicationStateDirectory,
	resolveNodeCutoverClosureLedgerPath,
	resolveReconcilerDbPath,
	resolveReconcilerStateDirectory,
} from "../../src/modules/reconciliation/reconciler-db.ts";

describe("reconciler-db", () => {
	let stateDir: string;
	let dbPath: string;

	beforeEach(() => {
		stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "reconciler-db-"));
		dbPath = resolveReconcilerDbPath(stateDir);
	});

	afterEach(() => {
		fs.rmSync(stateDir, { recursive: true, force: true });
	});

	test("resolves state outside the repository with absolute overrides", () => {
		const homeDirectory = path.join(stateDir, "home");
		assert.strictEqual(
			resolveApplicationStateDirectory({}, homeDirectory),
			path.join(homeDirectory, ".local", "state", "git-commits-push"),
		);
		assert.strictEqual(
			resolveReconcilerStateDirectory({}, homeDirectory),
			path.join(homeDirectory, ".local", "state", "git-commits-push", "orders"),
		);
		assert.strictEqual(
			resolveApplicationStateDirectory({ XDG_STATE_HOME: "" }, homeDirectory),
			path.join(homeDirectory, ".local", "state", "git-commits-push"),
		);
		assert.strictEqual(
			resolveNodeCutoverClosureLedgerPath(
				{ XDG_STATE_HOME: path.join(homeDirectory, "state") },
				homeDirectory,
			),
			path.join(
				homeDirectory,
				"state",
				"git-commits-push",
				"node-cutover-closures.json",
			),
		);
		assert.strictEqual(
			resolveReconcilerStateDirectory(
				{ ORDER_STATE_DIR: "~/custom-orders" },
				homeDirectory,
			),
			path.join(homeDirectory, "custom-orders"),
		);
		assert.throws(
			() =>
				resolveReconcilerStateDirectory(
					{ ORDER_STATE_DIR: "relative/orders" },
					homeDirectory,
				),
			/ORDER_STATE_DIR must resolve to an absolute path/,
		);
		assert.throws(
			() =>
				resolveApplicationStateDirectory(
					{ XDG_STATE_HOME: "relative/state" },
					homeDirectory,
				),
			/XDG_STATE_HOME must resolve to an absolute path/,
		);
	});

	test("U1 | fresh database creates exactly one idle state row", () => {
		const db = openReconcilerDb(dbPath);
		try {
			const state = readReconcilerState(db);
			assert.strictEqual(state.singletonId, 1);
			assert.strictEqual(state.requestedGeneration, 0);
			assert.strictEqual(state.completedGeneration, 0);
			assert.strictEqual(state.runningGeneration, null);
			assert.strictEqual(state.ownerToken, null);
			assert.strictEqual(state.ownerPid, null);
			assert.strictEqual(state.ownerBootEpochMs, null);
			assert.strictEqual(state.ownerCallerName, null);
			assert.strictEqual(state.ownerOriginAgent, null);
			assert.strictEqual(state.ownerSessionId, null);
			assert.strictEqual(state.ownerInvocationMode, null);
			assert.strictEqual(state.heartbeatAtEpochMs, null);
			assert.strictEqual(state.activeExecution, null);
			assert.strictEqual(countReconcilerStateRows(db), 1);
			assert.deepStrictEqual(listReconcilerTables(db), ["reconciler_state"]);
		} finally {
			db.close();
		}
		assert.strictEqual(
			fs.existsSync(path.join(stateDir, RECONCILER_DB_FILE_NAME)),
			true,
		);
		const db2 = openReconcilerDb(dbPath);
		try {
			const versionRow = db2.prepare("PRAGMA user_version").get() as {
				user_version: number;
			};
			assert.strictEqual(versionRow.user_version, RECONCILER_SCHEMA_VERSION);
		} finally {
			db2.close();
		}
	});

	test("U1b | reopening an initialized database preserves the singleton row", () => {
		const first = openReconcilerDb(dbPath);
		first.close();
		const second = openReconcilerDb(dbPath);
		try {
			assert.strictEqual(countReconcilerStateRows(second), 1);
			const state = readReconcilerState(second);
			assert.strictEqual(state.requestedGeneration, 0);
		} finally {
			second.close();
		}
	});

	test("U12 | corrupted database file fails closed and is not deleted", () => {
		fs.writeFileSync(dbPath, "this is not a sqlite database\n", "utf-8");
		assert.throws(
			() => openReconcilerDb(dbPath),
			(error) => {
				assert.ok(error instanceof ReconcilerOpenError);
				assert.strictEqual((error as ReconcilerOpenError).kind, "corrupt");
				assert.match(error.message, /reconciler/);
				return true;
			},
		);
		assert.strictEqual(fs.existsSync(dbPath), true);
	});

	test("U12b | incompatible schema version fails closed", () => {
		const db = openReconcilerDb(dbPath);
		db.close();
		const raw = new DatabaseSync(dbPath);
		try {
			raw.exec("PRAGMA user_version = 999");
		} finally {
			raw.close();
		}
		assert.throws(
			() => openReconcilerDb(dbPath),
			(error) => {
				assert.ok(error instanceof ReconcilerOpenError);
				assert.strictEqual(
					(error as ReconcilerOpenError).kind,
					"incompatible-schema",
				);
				return true;
			},
		);
	});

	const V3_SCHEMA_SQL = `
CREATE TABLE reconciler_state (
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
	execution_token TEXT,
	execution_generation INTEGER,
	execution_pid INTEGER,
	execution_process_identity TEXT,
	execution_group_id INTEGER,
	execution_boundary_kind TEXT,
	execution_owner_token TEXT,
	execution_state TEXT,
	CHECK (requested_generation >= completed_generation)
) STRICT;
PRAGMA user_version = 3;
`;

	function createV3Database(
		requireIdle: boolean,
		requestedGeneration = 7,
		completedGeneration = 7,
	): void {
		const raw = new DatabaseSync(dbPath);
		try {
			raw.exec(V3_SCHEMA_SQL);
			raw
				.prepare(
					"INSERT INTO reconciler_state (singleton_id, requested_generation, completed_generation) VALUES (1, ?, ?)",
				)
				.run(requestedGeneration, completedGeneration);
			if (!requireIdle) {
				raw.exec(
					"UPDATE reconciler_state SET running_generation = 2, owner_token = 'v3-owner', owner_pid = 4242, owner_boot_epoch_ms = 1, owner_process_identity = 'v3-identity', owner_caller_name = 'v3', owner_origin_agent = 'v3', heartbeat_at_epoch_ms = 1, execution_token = 'v3-execution', execution_generation = 1, execution_pid = 4343, execution_process_identity = 'v3-execution-identity', execution_group_id = 4343, execution_boundary_kind = 'posix-session-process-group-v1', execution_owner_token = 'v3-owner', execution_state = 'START_AUTHORIZED' WHERE singleton_id = 1",
				);
			}
		} finally {
			raw.close();
		}
	}

	function userVersionOf(targetPath: string): number {
		const raw = new DatabaseSync(targetPath);
		try {
			const row = raw.prepare("PRAGMA user_version").get() as {
				user_version?: number;
			};
			return Number(row?.user_version ?? 0);
		} finally {
			raw.close();
		}
	}

	function tableColumns(targetPath: string): string[] {
		const raw = new DatabaseSync(targetPath);
		try {
			return (
				raw.prepare("PRAGMA table_info(reconciler_state)").all() as Array<{
					name: string;
				}>
			).map((column) => column.name);
		} finally {
			raw.close();
		}
	}

	test("U13 | an idle converged schema-v3 singleton migrates atomically to v4", () => {
		createV3Database(true, 7, 7);
		const db = openReconcilerDb(dbPath);
		try {
			const state = readReconcilerState(db);
			assert.strictEqual(state.requestedGeneration, 7);
			assert.strictEqual(state.completedGeneration, 7);
			assert.strictEqual(state.runningGeneration, null);
			assert.strictEqual(state.ownerToken, null);
			assert.strictEqual(state.ownerInvocationMode, null);
			assert.strictEqual(countReconcilerStateRows(db), 1);
			assert.deepStrictEqual(listReconcilerTables(db), ["reconciler_state"]);
		} finally {
			db.close();
		}
		assert.strictEqual(userVersionOf(dbPath), RECONCILER_SCHEMA_VERSION);
		assert.ok(tableColumns(dbPath).includes("owner_invocation_mode"));
	});

	test("U14 | read-only open of schema v3 never migrates", () => {
		createV3Database(true, 7, 7);
		assert.throws(
			() => openReconcilerDb(dbPath, { readOnly: true }),
			(error) => {
				assert.ok(error instanceof ReconcilerOpenError);
				assert.strictEqual(
					(error as ReconcilerOpenError).kind,
					"incompatible-schema",
				);
				return true;
			},
		);
		assert.strictEqual(userVersionOf(dbPath), 3);
		assert.strictEqual(
			tableColumns(dbPath).includes("owner_invocation_mode"),
			false,
		);
	});

	test("U15 | non-idle schema v3 fails closed and is preserved", () => {
		const assertRefused = (): void => {
			assert.throws(
				() => openReconcilerDb(dbPath),
				(error) => {
					assert.ok(error instanceof ReconcilerOpenError);
					assert.strictEqual(
						(error as ReconcilerOpenError).kind,
						"incompatible-schema",
					);
					return true;
				},
			);
			assert.strictEqual(userVersionOf(dbPath), 3);
			assert.strictEqual(
				tableColumns(dbPath).includes("owner_invocation_mode"),
				false,
			);
		};

		// Pending generations: requested > completed with no owner.
		createV3Database(true, 3, 1);
		assertRefused();

		// Running owner without execution.
		fs.rmSync(dbPath, { force: true });
		fs.rmSync(`${dbPath}-wal`, { force: true });
		fs.rmSync(`${dbPath}-shm`, { force: true });
		const rawOwner = new DatabaseSync(dbPath);
		try {
			rawOwner.exec(V3_SCHEMA_SQL);
			rawOwner.exec(
				"INSERT INTO reconciler_state (singleton_id, requested_generation, completed_generation) VALUES (1, 2, 0)",
			);
			rawOwner.exec(
				"UPDATE reconciler_state SET running_generation = 2, owner_token = 'v3-owner', owner_pid = 4242, owner_boot_epoch_ms = 1, owner_process_identity = 'v3-identity', owner_caller_name = 'v3', owner_origin_agent = 'v3', heartbeat_at_epoch_ms = 1 WHERE singleton_id = 1",
			);
		} finally {
			rawOwner.close();
		}
		assertRefused();

		// Active execution under a running owner.
		fs.rmSync(dbPath, { force: true });
		fs.rmSync(`${dbPath}-wal`, { force: true });
		fs.rmSync(`${dbPath}-shm`, { force: true });
		createV3Database(false, 2, 0);
		assertRefused();
	});

	test("U12c | impossible invariant state fails closed on read", () => {
		const db = openReconcilerDb(dbPath);
		db.close();
		const raw = new DatabaseSync(dbPath);
		try {
			// running_generation beyond requested_generation passes the table
			// CHECKs but violates the reconciliation invariant (no pass may run
			// for a generation nobody requested).
			raw.exec(
				"UPDATE reconciler_state SET running_generation = 999, owner_token = 't', owner_pid = 1, owner_boot_epoch_ms = 0, owner_process_identity = 'test-process', owner_caller_name = 'test', owner_origin_agent = 'test', owner_invocation_mode = 'global', heartbeat_at_epoch_ms = 0 WHERE singleton_id = 1",
			);
		} finally {
			raw.close();
		}
		const reopened = openReconcilerDb(dbPath);
		try {
			assert.throws(
				() => readReconcilerState(reopened),
				(error) => {
					assert.ok(error instanceof ReconcilerInvariantError);
					assert.match(error.message, /running_generation/);
					return true;
				},
			);
		} finally {
			reopened.close();
		}
	});

	test("U12d | owner fields must be set and cleared together", () => {
		const db = openReconcilerDb(dbPath);
		db.close();
		const raw = new DatabaseSync(dbPath);
		try {
			raw.exec(
				"UPDATE reconciler_state SET owner_token = 'orphan-token', running_generation = NULL WHERE singleton_id = 1",
			);
		} finally {
			raw.close();
		}
		const reopened = openReconcilerDb(dbPath);
		try {
			assert.throws(
				() => readReconcilerState(reopened),
				(error) => {
					assert.ok(error instanceof ReconcilerInvariantError);
					assert.match(error.message, /owner/);
					return true;
				},
			);
		} finally {
			reopened.close();
		}
	});

	test("U12e | orphaned owner boot metadata fails closed", () => {
		const db = openReconcilerDb(dbPath);
		db.close();
		const raw = new DatabaseSync(dbPath);
		try {
			raw.exec(
				"UPDATE reconciler_state SET owner_boot_epoch_ms = 123 WHERE singleton_id = 1",
			);
		} finally {
			raw.close();
		}
		const reopened = openReconcilerDb(dbPath);
		try {
			assert.throws(
				() => readReconcilerState(reopened),
				(error) => {
					assert.ok(error instanceof ReconcilerInvariantError);
					assert.match(error.message, /owner/);
					return true;
				},
			);
		} finally {
			reopened.close();
		}
	});

	test("U12f | the singleton CHECK constraint rejects a second state row", () => {
		const db = openReconcilerDb(dbPath);
		db.close();
		const raw = new DatabaseSync(dbPath);
		try {
			assert.throws(() =>
				raw.exec(
					"INSERT INTO reconciler_state (singleton_id, requested_generation, completed_generation) VALUES (2, 0, 0)",
				),
			);
		} finally {
			raw.close();
		}
		const reopened = openReconcilerDb(dbPath);
		try {
			assert.strictEqual(countReconcilerStateRows(reopened), 1);
		} finally {
			reopened.close();
		}
	});

	test("read-only open of an absent database fails closed without creating files", () => {
		assert.throws(
			() => openReconcilerDb(dbPath, { readOnly: true }),
			(error) => {
				assert.ok(error instanceof ReconcilerOpenError);
				assert.strictEqual((error as ReconcilerOpenError).kind, "missing");
				return true;
			},
		);
		assert.strictEqual(fs.existsSync(dbPath), false);
	});
});
