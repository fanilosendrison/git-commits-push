import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { assertLegacyApplicationStateMigrated } from "../../scripts/legacy-state-cutover.mjs";
import { migrateApplicationState } from "../../scripts/state-migration.mjs";
import { openReconcilerDb } from "../../src/modules/reconciliation/reconciler-db.ts";

async function withTemporaryDirectory(callback) {
	const directory = await mkdtemp(path.join(tmpdir(), "state-migration-é-"));
	try {
		await callback(directory);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

function createIdleDatabase(stateRoot) {
	const orderStateDirectory = path.join(stateRoot, "orders");
	return mkdir(orderStateDirectory, { recursive: true }).then(() => {
		const dbPath = path.join(orderStateDirectory, "reconciler.sqlite");
		const db = openReconcilerDb(dbPath);
		db.close();
		return dbPath;
	});
}

test("moves the complete state container and preserves the database inode", async () => {
	await withTemporaryDirectory(async (root) => {
		const sourceRoot = path.join(root, "legacy", ".state");
		const targetRoot = path.join(root, "xdg", "git-commits-push");
		const sourceDbPath = await createIdleDatabase(sourceRoot);
		await writeFile(
			path.join(sourceRoot, "node-cutover-closures.json"),
			"[]\n",
		);
		const sourceInode = (await stat(sourceDbPath)).ino;
		const result = migrateApplicationState({ sourceRoot, targetRoot });
		assert.equal(result.outcome, "migrated");
		await assert.rejects(stat(sourceRoot), { code: "ENOENT" });
		assert.equal(
			(await stat(path.join(targetRoot, "orders", "reconciler.sqlite"))).ino,
			sourceInode,
		);
		assert.equal(
			(
				await stat(path.join(targetRoot, "node-cutover-closures.json"))
			).isFile(),
			true,
		);
	});
});

test("launcher guard rejects unmigrated default state", async () => {
	await withTemporaryDirectory(async (homeDirectory) => {
		const sourceRoot = path.join(
			homeDirectory,
			".agents",
			"skills",
			"git-commits-push",
			".state",
		);
		await mkdir(sourceRoot, { recursive: true });
		assert.throws(
			() =>
				assertLegacyApplicationStateMigrated({
					environment: {},
					homeDirectory,
				}),
			/run `pnpm run migrate:state`/,
		);
		assert.doesNotThrow(() =>
			assertLegacyApplicationStateMigrated({
				environment: { ORDER_STATE_DIR: path.join(homeDirectory, "custom") },
				homeDirectory,
			}),
		);
	});
});

test("refuses an existing uninitialized reconciler database", async () => {
	await withTemporaryDirectory(async (root) => {
		const sourceRoot = path.join(root, "source");
		const targetRoot = path.join(root, "target");
		const dbPath = path.join(sourceRoot, "orders", "reconciler.sqlite");
		await mkdir(path.dirname(dbPath), { recursive: true });
		await writeFile(dbPath, "");

		assert.throws(
			() => migrateApplicationState({ sourceRoot, targetRoot }),
			/uninitialized or non-regular reconciler database/,
		);
		assert.equal((await stat(dbPath)).size, 0);
		await assert.rejects(stat(targetRoot), { code: "ENOENT" });
	});
});

test("refuses migration while the shared state cutover lock is held", async () => {
	await withTemporaryDirectory(async (root) => {
		const sourceRoot = path.join(root, "source");
		const targetRoot = path.join(root, "target");
		const lockPath = `${targetRoot}.migration-lock`;
		await mkdir(sourceRoot);
		await mkdir(lockPath);

		assert.throws(
			() => migrateApplicationState({ sourceRoot, targetRoot }),
			/state migration lock is already held/i,
		);
		assert.equal((await stat(sourceRoot)).isDirectory(), true);
		await assert.rejects(stat(targetRoot), { code: "ENOENT" });
	});
});

test("does not classify existing target state while another migration holds the lock", async () => {
	await withTemporaryDirectory(async (root) => {
		const sourceRoot = path.join(root, "source");
		const targetRoot = path.join(root, "target");
		await mkdir(targetRoot);
		await mkdir(`${targetRoot}.migration-lock`);

		assert.throws(
			() => migrateApplicationState({ sourceRoot, targetRoot }),
			/state migration lock is already held/i,
		);
		await assert.rejects(stat(sourceRoot), { code: "ENOENT" });
		assert.equal((await stat(targetRoot)).isDirectory(), true);
	});
});

test("reports already-migrated state without moving the target", async () => {
	await withTemporaryDirectory(async (root) => {
		const sourceRoot = path.join(root, "source");
		const targetRoot = path.join(root, "target");
		await mkdir(targetRoot);

		assert.deepEqual(migrateApplicationState({ sourceRoot, targetRoot }), {
			outcome: "already-migrated",
		});
		await assert.rejects(stat(sourceRoot), { code: "ENOENT" });
		assert.equal((await stat(targetRoot)).isDirectory(), true);
		await assert.rejects(stat(`${targetRoot}.migration-lock`), {
			code: "ENOENT",
		});
	});
});

test("refuses divergent source and target roots", async () => {
	await withTemporaryDirectory(async (root) => {
		const sourceRoot = path.join(root, "source");
		const targetRoot = path.join(root, "target");
		await mkdir(sourceRoot);
		await mkdir(targetRoot);
		assert.throws(
			() => migrateApplicationState({ sourceRoot, targetRoot }),
			/both exist; refusing divergent state/,
		);
	});
});

test("refuses state with an active reconciler owner", async () => {
	await withTemporaryDirectory(async (root) => {
		const sourceRoot = path.join(root, "source");
		const targetRoot = path.join(root, "target");
		const dbPath = await createIdleDatabase(sourceRoot);
		const db = new DatabaseSync(dbPath);
		db.exec(`UPDATE reconciler_state SET
			requested_generation = 1,
			running_generation = 1,
			owner_token = 'owner',
			owner_pid = 42,
			owner_boot_epoch_ms = 1,
			owner_process_identity = 'identity',
			owner_caller_name = 'test',
			owner_origin_agent = 'test',
			heartbeat_at_epoch_ms = 1
			WHERE singleton_id = 1`);
		db.close();
		assert.throws(
			() => migrateApplicationState({ sourceRoot, targetRoot }),
			/while reconciler owner pid 42 is recorded/,
		);
		assert.equal((await stat(sourceRoot)).isDirectory(), true);
		await assert.rejects(stat(targetRoot), { code: "ENOENT" });
	});
});
