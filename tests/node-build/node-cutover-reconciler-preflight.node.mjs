import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "../..");
const compiledRoot = path.join(
	skillDirectory,
	"dist",
	"skills",
	"git-commits-push",
	"src",
);
const { inspectNodeCutoverState } = await import(
	pathToFileURL(path.join(compiledRoot, "utils", "node-cutover-preflight.js"))
		.href
);
const reconcilerDb = await import(
	pathToFileURL(
		path.join(compiledRoot, "modules", "reconciliation", "reconciler-db.js"),
	).href
);
const NOW_EPOCH_MS = 1_800_000_000_000;

async function withFixture(callback) {
	const root = await mkdtemp(path.join(tmpdir(), "cutover-reconciler-é-"));
	const fixture = {
		closureLedgerPath: path.join(root, "closure ledger.json"),
		orderStateDirectory: path.join(root, "queue 漢字"),
		runsDirectory: path.join(root, "runs", "git-commits-push-tl"),
	};
	await mkdir(fixture.runsDirectory, { recursive: true });
	await mkdir(fixture.orderStateDirectory, { recursive: true });
	try {
		await callback(fixture);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
}

function inspectFixture(fixture) {
	return inspectNodeCutoverState({
		closureLedgerPath: fixture.closureLedgerPath,
		nowEpochMs: NOW_EPOCH_MS,
		orderStateDirectory: fixture.orderStateDirectory,
		runsDirectory: fixture.runsDirectory,
	});
}

test("an idle SQLite reconciler database is not a blocker", async () => {
	await withFixture(async (fixture) => {
		const db = reconcilerDb.openReconcilerDb(
			reconcilerDb.resolveReconcilerDbPath(fixture.orderStateDirectory),
		);
		db.close();
		const report = inspectFixture(fixture);
		assert.equal(report.ready, true);
		assert.deepEqual(report.blockers, []);
	});
});

test("an active reconciler owner blocks cutover", async () => {
	await withFixture(async (fixture) => {
		const dbPath = reconcilerDb.resolveReconcilerDbPath(
			fixture.orderStateDirectory,
		);
		const db = reconcilerDb.openReconcilerDb(dbPath);
		db.close();
		const raw = new DatabaseSync(dbPath);
		try {
			raw.exec(
				"UPDATE reconciler_state SET requested_generation = 3, completed_generation = 0, running_generation = 3, owner_token = 'live-token', owner_pid = 4242, owner_boot_epoch_ms = 1800000000000, owner_process_identity = 'test-process', owner_caller_name = 'active', owner_origin_agent = 'test', heartbeat_at_epoch_ms = 1800000000000 WHERE singleton_id = 1",
			);
		} finally {
			raw.close();
		}
		const report = inspectFixture(fixture);
		assert.equal(report.ready, false);
		assert.deepEqual(
			report.blockers.map(({ kind }) => kind),
			["active-reconciler"],
		);
	});
});

test("pending unreconciled generations without an owner block cutover", async () => {
	await withFixture(async (fixture) => {
		const dbPath = reconcilerDb.resolveReconcilerDbPath(
			fixture.orderStateDirectory,
		);
		const db = reconcilerDb.openReconcilerDb(dbPath);
		db.close();
		const raw = new DatabaseSync(dbPath);
		try {
			raw.exec(
				"UPDATE reconciler_state SET requested_generation = 5, completed_generation = 2 WHERE singleton_id = 1",
			);
		} finally {
			raw.close();
		}
		const report = inspectFixture(fixture);
		assert.equal(report.ready, false);
		assert.deepEqual(
			report.blockers.map(({ kind }) => kind),
			["pending-reconciliation"],
		);
	});
});

test("a corrupt or incompatible reconciler database fails closed", async () => {
	await withFixture(async (fixture) => {
		const dbPath = reconcilerDb.resolveReconcilerDbPath(
			fixture.orderStateDirectory,
		);
		await writeFile(dbPath, "not a sqlite database\n");
		const corruptReport = inspectFixture(fixture);
		assert.equal(corruptReport.ready, false);
		assert.deepEqual(
			corruptReport.blockers.map(({ kind }) => kind),
			["corrupt-reconciler-db"],
		);

		await rm(dbPath);
		const db = reconcilerDb.openReconcilerDb(dbPath);
		db.close();
		const raw = new DatabaseSync(dbPath);
		try {
			raw.exec("PRAGMA user_version = 999");
		} finally {
			raw.close();
		}
		const incompatibleReport = inspectFixture(fixture);
		assert.equal(incompatibleReport.ready, false);
		assert.deepEqual(
			incompatibleReport.blockers.map(({ kind }) => kind),
			["incompatible-reconciler-db"],
		);
	});
});
