import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrateReconcilerV2Database } from "../../scripts/reconciler-v2-migration.mjs";
import {
	openReconcilerDb,
	readReconcilerState,
} from "../../src/modules/reconciliation/reconciler-db.ts";

const V2_SCHEMA_SQL = `
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
	CHECK (requested_generation >= completed_generation)
) STRICT;
INSERT INTO reconciler_state (
	singleton_id, requested_generation, completed_generation
) VALUES (1, 0, 0);
PRAGMA user_version = 2;
`;

async function withV2Database(callback) {
	const root = await mkdtemp(path.join(tmpdir(), "reconciler-v2-migration-"));
	try {
		await mkdir(root, { recursive: true });
		const dbPath = path.join(root, "reconciler.sqlite");
		const db = new DatabaseSync(dbPath);
		try {
			db.exec(V2_SCHEMA_SQL);
		} finally {
			db.close();
		}
		await callback(dbPath);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
}

test("schema-v2 migration requires explicit external no-process proof", async () => {
	await withV2Database(async (dbPath) => {
		assert.throws(
			() =>
				migrateReconcilerV2Database({
					confirmedNoLiveExecution: false,
					dbPath,
				}),
			/explicit confirmation/u,
		);
		const db = new DatabaseSync(dbPath);
		try {
			assert.strictEqual(
				db.prepare("PRAGMA user_version").get().user_version,
				2,
			);
		} finally {
			db.close();
		}
	});
});

test("schema-v2 migration rejects active or pending durable state", async () => {
	await withV2Database(async (dbPath) => {
		const db = new DatabaseSync(dbPath);
		try {
			db.exec(
				"UPDATE reconciler_state SET requested_generation = 1, running_generation = 1, owner_token = 'owner', owner_pid = 42, owner_boot_epoch_ms = 1, owner_process_identity = 'identity', owner_caller_name = 'test', owner_origin_agent = 'test', heartbeat_at_epoch_ms = 1 WHERE singleton_id = 1",
			);
		} finally {
			db.close();
		}
		assert.throws(
			() =>
				migrateReconcilerV2Database({
					confirmedNoLiveExecution: true,
					dbPath,
				}),
			/requires requested_generation to equal completed_generation|idle row/u,
		);
	});
});

test("confirmed idle schema-v2 singleton migrates in place to bounded v3", async () => {
	await withV2Database(async (dbPath) => {
		assert.deepStrictEqual(
			migrateReconcilerV2Database({
				confirmedNoLiveExecution: true,
				dbPath,
			}),
			{ outcome: "migrated" },
		);
		const db = openReconcilerDb(dbPath);
		try {
			const state = readReconcilerState(db);
			assert.strictEqual(state.requestedGeneration, 0);
			assert.strictEqual(state.completedGeneration, 0);
			assert.strictEqual(state.activeExecution, null);
			const tables = db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
				)
				.all();
			assert.deepStrictEqual(
				tables.map(({ name }) => name),
				["reconciler_state"],
			);
		} finally {
			db.close();
		}
	});
});
