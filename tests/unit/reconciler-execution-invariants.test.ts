import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	openReconcilerDb,
	ReconcilerInvariantError,
	ReconcilerOpenError,
	readReconcilerState,
	resolveReconcilerDbPath,
} from "../../src/modules/reconciliation/reconciler-db.ts";

const ACTIVE_OWNER_SQL = `
	requested_generation = 2,
	completed_generation = 0,
	running_generation = 2,
	owner_token = 'owner-b',
	owner_pid = 4242,
	owner_boot_epoch_ms = 1,
	owner_process_identity = 'owner-identity',
	owner_caller_name = 'test',
	owner_origin_agent = 'test',
	heartbeat_at_epoch_ms = 1`;

const ACTIVE_EXECUTION_SQL = `
	execution_token = 'execution-a',
	execution_generation = 1,
	execution_pid = 4343,
	execution_process_identity = 'execution-identity',
	execution_group_id = 4343,
	execution_boundary_kind = 'posix-session-process-group-v1',
	execution_owner_token = 'owner-a',
	execution_state = 'START_AUTHORIZED'`;

describe("active execution database invariants", () => {
	let stateDirectory: string;
	let dbPath: string;

	beforeEach(() => {
		stateDirectory = fs.mkdtempSync(
			path.join(os.tmpdir(), "reconciler-execution-invariants-"),
		);
		dbPath = resolveReconcilerDbPath(stateDirectory);
		const db = openReconcilerDb(dbPath);
		db.close();
	});

	afterEach(() => {
		fs.rmSync(stateDirectory, { force: true, recursive: true });
	});

	function update(assignments: string): void {
		const raw = new DatabaseSync(dbPath);
		try {
			raw.exec(
				`UPDATE reconciler_state SET ${assignments} WHERE singleton_id = 1`,
			);
		} finally {
			raw.close();
		}
	}

	function assertInvariant(pattern: RegExp): void {
		const db = openReconcilerDb(dbPath);
		try {
			assert.throws(
				() => readReconcilerState(db),
				(error) => {
					assert.ok(error instanceof ReconcilerInvariantError);
					assert.match(error.message, pattern);
					return true;
				},
			);
		} finally {
			db.close();
		}
	}

	test("EXEC-1 | execution fields are all set or all cleared", () => {
		update(`${ACTIVE_OWNER_SQL}, execution_token = 'partial'`);
		assertInvariant(/execution fields must be set and cleared together/u);
	});

	test("EXEC-2/3 | execution generation belongs to current or explicit recovery context", () => {
		update(`${ACTIVE_OWNER_SQL}, ${ACTIVE_EXECUTION_SQL}`);
		const db = openReconcilerDb(dbPath);
		try {
			const execution = readReconcilerState(db).activeExecution;
			assert.strictEqual(execution?.generation, 1);
			assert.strictEqual(execution?.ownerToken, "owner-a");
		} finally {
			db.close();
		}

		update("execution_generation = 3");
		assertInvariant(/execution_generation/u);
	});

	test("EXEC-3 | mixed owner and generation relationship fails closed", () => {
		update(
			`${ACTIVE_OWNER_SQL}, ${ACTIVE_EXECUTION_SQL}, execution_owner_token = 'owner-b'`,
		);
		assertInvariant(/current running owner or to an older generation/u);
	});

	test("EXEC-9 | execution PID and PGID must share the durable leader identity", () => {
		update(
			`${ACTIVE_OWNER_SQL}, ${ACTIVE_EXECUTION_SQL}, execution_group_id = 9999`,
		);
		assertInvariant(/pid and process-group id/u);
	});

	test("schema v2 is rejected rather than interpreted as no active execution", () => {
		update("requested_generation = 0");
		const raw = new DatabaseSync(dbPath);
		try {
			raw.exec("PRAGMA user_version = 2");
		} finally {
			raw.close();
		}
		assert.throws(
			() => openReconcilerDb(dbPath),
			(error) => {
				assert.ok(error instanceof ReconcilerOpenError);
				assert.strictEqual(error.kind, "incompatible-schema");
				assert.match(error.message, /offline migration/u);
				return true;
			},
		);
	});
});
