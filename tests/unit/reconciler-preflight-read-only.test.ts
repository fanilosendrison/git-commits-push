import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
	openReconcilerDb,
	resolveReconcilerDbPath,
} from "../../src/modules/reconciliation/reconciler-db.ts";
import { inspectReconciliationPreflightState } from "../../src/modules/reconciliation/reconciler-preflight.ts";

interface FileSnapshot {
	readonly digest: string;
	readonly size: number;
}

const cleanup: string[] = [];

function createStateDirectory(): string {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "reconciler-preflight-read-only-"),
	);
	cleanup.push(directory);
	return directory;
}

function snapshotDirectory(
	directory: string,
): Readonly<Record<string, FileSnapshot>> {
	return Object.fromEntries(
		fs
			.readdirSync(directory)
			.sort()
			.map((name) => {
				const content = fs.readFileSync(path.join(directory, name));
				return [
					name,
					{
						digest: createHash("sha256").update(content).digest("hex"),
						size: content.length,
					},
				];
			}),
	);
}

afterEach(() => {
	for (const directory of cleanup.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("read-only reconciler preflight", () => {
	test("does not create SQLite sidecars while inspecting a stable database", () => {
		const stateDirectory = createStateDirectory();
		const dbPath = resolveReconcilerDbPath(stateDirectory);
		const db = openReconcilerDb(dbPath);
		db.close();
		const before = snapshotDirectory(stateDirectory);
		assert.deepStrictEqual(Object.keys(before), ["reconciler.sqlite"]);

		const blockers = inspectReconciliationPreflightState(
			stateDirectory,
			1_800_000_000_000,
		);

		assert.deepStrictEqual(blockers, []);
		assert.deepStrictEqual(snapshotDirectory(stateDirectory), before);
	});

	test("fails closed without opening an uncheckpointed WAL database", () => {
		const stateDirectory = createStateDirectory();
		const dbPath = resolveReconcilerDbPath(stateDirectory);
		const db = openReconcilerDb(dbPath);
		try {
			db.exec("PRAGMA wal_autocheckpoint = 0");
			db.exec(
				"UPDATE reconciler_state SET requested_generation = 1, running_generation = 1, owner_token = 'owner', owner_pid = 4242, owner_boot_epoch_ms = 1800000000000, owner_process_identity = 'test-process', owner_caller_name = 'test', owner_origin_agent = 'test', heartbeat_at_epoch_ms = 1800000000000 WHERE singleton_id = 1",
			);
			const before = snapshotDirectory(stateDirectory);
			assert.ok(Object.hasOwn(before, "reconciler.sqlite-wal"));
			assert.ok(Object.hasOwn(before, "reconciler.sqlite-shm"));

			const blockers = inspectReconciliationPreflightState(
				stateDirectory,
				1_800_000_000_000,
			);

			assert.deepStrictEqual(
				blockers.map(({ kind }) => kind),
				["uncheckpointed-reconciler-db"],
			);
			assert.deepStrictEqual(snapshotDirectory(stateDirectory), before);
		} finally {
			db.close();
		}
	});

	test("fails closed without changing a rollback journal", () => {
		const stateDirectory = createStateDirectory();
		const dbPath = resolveReconcilerDbPath(stateDirectory);
		const db = openReconcilerDb(dbPath);
		db.close();
		fs.writeFileSync(`${dbPath}-journal`, "preserved rollback state\n");
		const before = snapshotDirectory(stateDirectory);

		const blockers = inspectReconciliationPreflightState(
			stateDirectory,
			1_800_000_000_000,
		);

		assert.deepStrictEqual(
			blockers.map(({ kind }) => kind),
			["uncheckpointed-reconciler-db"],
		);
		assert.deepStrictEqual(snapshotDirectory(stateDirectory), before);
	});

	test("fails closed when the configured state path is inaccessible", () => {
		const blockedRoot = createStateDirectory();
		const stateDirectory = path.join(blockedRoot, "state");
		fs.mkdirSync(stateDirectory);
		fs.chmodSync(blockedRoot, 0);
		try {
			const blockers = inspectReconciliationPreflightState(
				stateDirectory,
				1_800_000_000_000,
			);
			assert.deepStrictEqual(
				blockers.map(({ kind }) => kind),
				["unreadable-order-state"],
			);
		} finally {
			fs.chmodSync(blockedRoot, 0o700);
		}
	});

	test("classifies an uninitialized SQLite file as corrupt", () => {
		const stateDirectory = createStateDirectory();
		fs.writeFileSync(resolveReconcilerDbPath(stateDirectory), "");

		const blockers = inspectReconciliationPreflightState(
			stateDirectory,
			1_800_000_000_000,
		);

		assert.deepStrictEqual(
			blockers.map(({ kind }) => kind),
			["corrupt-reconciler-db"],
		);
	});
});
