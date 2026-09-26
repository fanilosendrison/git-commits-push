import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import {
	cutoverLegacyGlobalRuns,
	inspectLegacyGlobalRunCutover,
} from "../../src/modules/reconciliation/legacy-global-run-cutover.ts";

const ORCHESTRATOR_NAME = "git-commits-push-tl";
const RUN_ID = "01J00000000000000000000051";
const REVOCATION_TIME = "2027-01-15T08:00:00.000Z";
const cleanup: string[] = [];

function stateFor(scope: "global" | "targeted"): Record<string, unknown> {
	return {
		currentPhase: "commit-and-push",
		data: {
			invocationScope:
				scope === "global"
					? { kind: "global" }
					: {
							kind: "targeted",
							pushRef: "refs/heads/main",
							pushRemote: "origin",
							repository: "/stale-projection",
						},
			repos: {},
		},
		orchestratorName: ORCHESTRATOR_NAME,
		runId: RUN_ID,
		schemaVersion: 4,
	};
}

function createFixture(ownershipStatus: "FREE" | "HELD") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "turnlock-inspection-"));
	const runsDirectory = path.join(root, "runs", ORCHESTRATOR_NAME);
	const quarantineDirectory = path.join(
		root,
		"revoked-runs",
		ORCHESTRATOR_NAME,
	);
	const runDirectory = path.join(runsDirectory, RUN_ID);
	fs.mkdirSync(runDirectory, { recursive: true });
	fs.writeFileSync(
		path.join(runDirectory, "state.json"),
		JSON.stringify(stateFor("targeted")),
	);
	writeSqliteAuthority(runDirectory, stateFor("global"), ownershipStatus);
	cleanup.push(root);
	return { quarantineDirectory, root, runDirectory, runsDirectory };
}

function writeSqliteAuthority(
	runDirectory: string,
	state: Record<string, unknown>,
	ownershipStatus: "FREE" | "HELD",
): void {
	const stateJson = JSON.stringify(state);
	const database = new DatabaseSync(
		path.join(runDirectory, "turnlock.sqlite3"),
	);
	try {
		database.exec(`
			CREATE TABLE schema_metadata (singleton INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL);
			CREATE TABLE run_incarnation (singleton INTEGER PRIMARY KEY, run_id TEXT NOT NULL, orchestrator_name TEXT NOT NULL);
			CREATE TABLE run_ownership (singleton INTEGER PRIMARY KEY, ownership_status TEXT NOT NULL, owner_token TEXT, owner_pid INTEGER, acquired_at_epoch_ms INTEGER, lease_until_epoch_ms INTEGER);
			CREATE TABLE run_state (singleton INTEGER PRIMARY KEY, state_schema_version INTEGER NOT NULL, state_json TEXT NOT NULL, state_digest TEXT NOT NULL);
		`);
		database.prepare("INSERT INTO schema_metadata VALUES (1, 2)").run();
		database
			.prepare("INSERT INTO run_incarnation VALUES (1, ?, ?)")
			.run(RUN_ID, ORCHESTRATOR_NAME);
		database
			.prepare("INSERT INTO run_ownership VALUES (1, ?, ?, ?, ?, ?)")
			.run(
				ownershipStatus,
				ownershipStatus === "HELD" ? "owner" : null,
				ownershipStatus === "HELD" ? 123 : null,
				ownershipStatus === "HELD" ? 1 : null,
				ownershipStatus === "HELD" ? 2 : null,
			);
		database
			.prepare("INSERT INTO run_state VALUES (1, ?, ?, ?)")
			.run(
				Number(state.schemaVersion),
				stateJson,
				`sha256:${createHash("sha256").update(stateJson).digest("hex")}`,
			);
	} finally {
		database.close();
	}
}

function leaveCommittedWal(databasePath: string): void {
	const child = spawnSync(
		process.execPath,
		[
			"-e",
			`const {DatabaseSync}=require("node:sqlite");
			 const db=new DatabaseSync(process.argv[1]);
			 db.prepare("PRAGMA journal_mode = WAL").get();
			 db.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE checkpoint_probe(value INTEGER); INSERT INTO checkpoint_probe VALUES (1)");
			 process.kill(process.pid,"SIGKILL");`,
			databasePath,
		],
		{ encoding: "utf8", shell: false },
	);
	assert.equal(child.signal, "SIGKILL", child.stderr);
	assert.equal(fs.existsSync(`${databasePath}-wal`), true);
}

afterEach(() => {
	for (const root of cleanup.splice(0)) {
		fs.rmSync(root, { force: true, recursive: true });
	}
});

describe("Turnlock run state inspection", () => {
	test("uses SQLite authority instead of a stale targeted projection", () => {
		const fixture = createFixture("FREE");

		const report = inspectLegacyGlobalRunCutover(fixture);

		assert.deepStrictEqual(report.candidates, [RUN_ID]);
		assert.deepStrictEqual(report.safe, []);
		assert.deepStrictEqual(report.blockers, []);
	});

	test("blocks a global run whose SQLite ownership is still held", () => {
		const fixture = createFixture("HELD");

		const report = inspectLegacyGlobalRunCutover(fixture);

		assert.deepStrictEqual(
			report.blockers.map(({ kind }) => kind),
			["turnlock-lock-present"],
		);
		assert.deepStrictEqual(report.candidates, []);
	});

	test("checkpoints abandoned WAL state only during confirmed apply", () => {
		const fixture = createFixture("FREE");
		const databasePath = path.join(fixture.runDirectory, "turnlock.sqlite3");
		leaveCommittedWal(databasePath);

		const dryRun = inspectLegacyGlobalRunCutover(fixture);
		assert.deepStrictEqual(
			dryRun.blockers.map(({ kind }) => kind),
			["uncheckpointed-turnlock-db"],
		);
		assert.equal(fs.existsSync(`${databasePath}-wal`), true);

		const applied = cutoverLegacyGlobalRuns({
			...fixture,
			confirmedNoLiveExecution: true,
			revokedAt: REVOCATION_TIME,
		});

		assert.equal(applied.ready, true);
		assert.deepStrictEqual(applied.revoked, [RUN_ID]);
		assert.equal(
			fs.lstatSync(path.join(fixture.runsDirectory, RUN_ID)).isFile(),
			true,
		);
	});
});
