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
	resolveReconcilerDbPath,
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
			assert.strictEqual(state.heartbeatAtEpochMs, null);
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

	test("U12c | impossible invariant state fails closed on read", () => {
		const db = openReconcilerDb(dbPath);
		db.close();
		const raw = new DatabaseSync(dbPath);
		try {
			// running_generation beyond requested_generation passes the table
			// CHECKs but violates the reconciliation invariant (no pass may run
			// for a generation nobody requested).
			raw.exec(
				"UPDATE reconciler_state SET running_generation = 999, owner_token = 't', owner_pid = 1, owner_boot_epoch_ms = 0, owner_process_identity = 'test-process', owner_caller_name = 'test', owner_origin_agent = 'test', heartbeat_at_epoch_ms = 0 WHERE singleton_id = 1",
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
