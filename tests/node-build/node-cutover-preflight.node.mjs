import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "../..");
const compiledPreflightPath = path.join(
	skillDirectory,
	"dist",
	"skills",
	"git-commits-push",
	"src",
	"utils",
	"node-cutover-preflight.js",
);
const preflightScriptPath = path.join(
	skillDirectory,
	"scripts",
	"check-node-cutover-state.mjs",
);
const { inspectNodeCutoverState } = await import(
	pathToFileURL(compiledPreflightPath).href
);

const NOW_EPOCH_MS = 1_800_000_000_000;
const DRAINED_RUN_ID = "01J00000000000000000000001";
const CLOSED_RUN_ID = "01J00000000000000000000002";
const INCOMPATIBLE_RUN_ID = "01J00000000000000000000003";
const ACTIVE_RUN_ID = "01J00000000000000000000004";

async function withFixture(callback) {
	const root = await mkdtemp(
		path.join(tmpdir(), "git-commits-push-cutover-é-"),
	);
	const runsDirectory = path.join(
		root,
		"Turnlock runs with spaces",
		"git-commits-push-tl",
	);
	const orderStateDirectory = path.join(root, "queue 漢字");
	const closureLedgerPath = path.join(root, "closure ledger.json");
	await mkdir(runsDirectory, { recursive: true });
	await mkdir(orderStateDirectory, { recursive: true });
	try {
		await callback({
			closureLedgerPath,
			orderStateDirectory,
			root,
			runsDirectory,
		});
	} finally {
		await rm(root, { force: true, recursive: true });
	}
}

async function writeRun(runsDirectory, runId, state, events = []) {
	const runDirectory = path.join(runsDirectory, runId);
	await mkdir(runDirectory, { recursive: true });
	if (state !== undefined) {
		await writeFile(
			path.join(runDirectory, "state.json"),
			JSON.stringify(state),
		);
	}
	if (events.length > 0) {
		await writeFile(
			path.join(runDirectory, "events.ndjson"),
			`${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
		);
	}
	return runDirectory;
}

function inspectFixture(fixture) {
	return inspectNodeCutoverState({
		closureLedgerPath: fixture.closureLedgerPath,
		nowEpochMs: NOW_EPOCH_MS,
		orderStateDirectory: fixture.orderStateDirectory,
		runsDirectory: fixture.runsDirectory,
	});
}

test("accepts an empty cutover state without creating files", async () => {
	await withFixture(async (fixture) => {
		const report = inspectFixture(fixture);
		assert.deepEqual(report, {
			blockers: [],
			classifications: [],
			ready: true,
			summary: {
				drained: 0,
				explicitlyClosed: 0,
				rejectedIncompatible: 0,
			},
			version: 1,
		});
	});
});

test("classifies drained, explicitly closed, and incompatible historical runs", async () => {
	await withFixture(async (fixture) => {
		await writeRun(
			fixture.runsDirectory,
			DRAINED_RUN_ID,
			{
				orchestratorName: "git-commits-push-tl",
				runId: DRAINED_RUN_ID,
				schemaVersion: 2,
			},
			[
				{
					eventType: "orchestrator_end",
					orchestratorName: "git-commits-push-tl",
					runId: DRAINED_RUN_ID,
					success: true,
				},
			],
		);
		await writeRun(fixture.runsDirectory, INCOMPATIBLE_RUN_ID, {
			orchestratorName: "git-commits-push-tl",
			runId: INCOMPATIBLE_RUN_ID,
			schemaVersion: 1,
		});
		await writeFile(
			fixture.closureLedgerPath,
			JSON.stringify({
				runs: [
					{
						closedAt: "2027-01-15T08:00:00.000Z",
						reason: "Reviewed and closed before the Node cutover",
						runId: CLOSED_RUN_ID,
					},
				],
				version: 1,
			}),
		);

		const report = inspectFixture(fixture);
		assert.equal(report.ready, false);
		assert.deepEqual(
			report.classifications.map(({ classification, runId }) => ({
				classification,
				runId,
			})),
			[
				{ classification: "drained", runId: DRAINED_RUN_ID },
				{ classification: "explicitly-closed", runId: CLOSED_RUN_ID },
				{
					classification: "rejected-incompatible",
					runId: INCOMPATIBLE_RUN_ID,
				},
			],
		);
		assert.deepEqual(report.summary, {
			drained: 1,
			explicitlyClosed: 1,
			rejectedIncompatible: 1,
		});
		assert.deepEqual(report.blockers, [
			{
				detail: "state schemaVersion 1 is incompatible with Node cutover",
				kind: "incompatible-run",
				subject: INCOMPATIBLE_RUN_ID,
			},
		]);
	});
});

test("requires orchestrator_end to be the final persisted event", async () => {
	await withFixture(async (fixture) => {
		await writeRun(
			fixture.runsDirectory,
			DRAINED_RUN_ID,
			{
				orchestratorName: "git-commits-push-tl",
				runId: DRAINED_RUN_ID,
				schemaVersion: 2,
			},
			[
				{
					eventType: "orchestrator_end",
					orchestratorName: "git-commits-push-tl",
					runId: DRAINED_RUN_ID,
					success: true,
				},
				{
					eventType: "phase_start",
					phase: "commit-and-push",
					runId: DRAINED_RUN_ID,
				},
			],
		);

		const report = inspectFixture(fixture);
		assert.equal(report.ready, false);
		assert.equal(
			report.classifications[0]?.classification,
			"rejected-incompatible",
		);
		assert.equal(
			report.blockers[0]?.detail,
			"historical non-terminal run requires explicit closure before cutover",
		);
	});
});

test("rejects malformed closure evidence and unexpected run-root entries", async () => {
	await withFixture(async (fixture) => {
		await writeFile(
			fixture.closureLedgerPath,
			JSON.stringify({
				runs: [
					{
						closedAt: "not-a-timestamp",
						reason: "invalid fixture",
						runId: "not-a-ulid",
					},
				],
				version: 1,
			}),
		);
		await writeFile(path.join(fixture.runsDirectory, "unexpected-entry"), "");

		const report = inspectFixture(fixture);
		assert.equal(report.ready, false);
		assert.deepEqual(
			report.blockers.map(({ kind }) => kind),
			["invalid-closure-ledger", "unexpected-run-entry"],
		);
		assert.deepEqual(report.classifications, []);
	});
});

test("fails closed on active or abandoned locks and pending queue artifacts", async () => {
	await withFixture(async (fixture) => {
		const activeRunDirectory = await writeRun(
			fixture.runsDirectory,
			ACTIVE_RUN_ID,
			{
				orchestratorName: "git-commits-push-tl",
				runId: ACTIVE_RUN_ID,
				schemaVersion: 2,
			},
		);
		await writeFile(
			path.join(activeRunDirectory, ".lock"),
			JSON.stringify({
				leaseUntilEpochMs: NOW_EPOCH_MS + 60_000,
				ownerPid: 123,
				ownerToken: "owner-token",
			}),
		);

		const queueLockPath = path.join(
			fixture.orderStateDirectory,
			"running.lock",
		);
		await writeFile(
			queueLockPath,
			JSON.stringify({
				callerName: "test",
				runId: ACTIVE_RUN_ID,
				timestamp: NOW_EPOCH_MS,
			}),
		);
		const liveLockTime = new Date(NOW_EPOCH_MS - 10_000);
		await utimes(queueLockPath, liveLockTime, liveLockTime);
		await writeFile(
			path.join(
				fixture.orderStateDirectory,
				"order-1800000000000-pending.json",
			),
			"{}",
		);

		const report = inspectFixture(fixture);
		assert.equal(report.ready, false);
		assert.deepEqual(
			report.blockers.map(({ kind }) => kind),
			[
				"active-turnlock-lock",
				"incompatible-run",
				"live-queue-lock",
				"pending-order",
			],
		);

		await writeFile(path.join(activeRunDirectory, ".lock"), "not-json");
		const staleLockTime = new Date(NOW_EPOCH_MS - 60_000);
		await utimes(queueLockPath, staleLockTime, staleLockTime);
		const abandonedReport = inspectFixture(fixture);
		assert.deepEqual(
			abandonedReport.blockers.map(({ kind }) => kind),
			[
				"malformed-turnlock-lock",
				"incompatible-run",
				"stale-queue-lock",
				"pending-order",
			],
		);
	});
});

test("CLI is read-only and emits distinct ready and blocked exit codes", async (context) => {
	const buildSentinel = path.join(
		skillDirectory,
		"dist",
		"preflight-read-only.marker",
	);
	await writeFile(buildSentinel, "must survive preflight\n");
	context.after(() => rm(buildSentinel, { force: true }));
	await withFixture(async (fixture) => {
		const turnlockRunRoot = path.dirname(fixture.runsDirectory);
		const baseEnvironment = {
			...process.env,
			GCP_NODE_CUTOVER_CLOSURE_LEDGER: fixture.closureLedgerPath,
			ORDER_STATE_DIR: fixture.orderStateDirectory,
			TURNLOCK_RUN_DIR_ROOT: turnlockRunRoot,
		};
		const ready = spawnSync(process.execPath, [preflightScriptPath], {
			cwd: skillDirectory,
			encoding: "utf8",
			env: baseEnvironment,
			shell: false,
		});
		assert.equal(ready.status, 0, ready.stderr);
		assert.equal(JSON.parse(ready.stdout).ready, true);

		await writeFile(
			path.join(fixture.orderStateDirectory, "order-hostile;touch-pwned.flag"),
			"",
		);
		const blocked = spawnSync(process.execPath, [preflightScriptPath], {
			cwd: skillDirectory,
			encoding: "utf8",
			env: baseEnvironment,
			shell: false,
		});
		assert.equal(blocked.status, 1, blocked.stderr);
		assert.deepEqual(
			JSON.parse(blocked.stdout).blockers.map(({ kind }) => kind),
			["unreadable-order-state"],
		);
		assert.equal(
			await import("node:fs").then(({ existsSync }) =>
				existsSync(path.join(skillDirectory, "pwned")),
			),
			false,
		);
		assert.strictEqual(
			await import("node:fs").then(({ existsSync }) =>
				existsSync(buildSentinel),
			),
			true,
			"read-only preflight must not rebuild or replace dist",
		);
	});
});
