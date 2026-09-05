import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import { inspectHistoricalTurnlockState } from "../../src/modules/reconciliation/historical-turnlock-state.ts";

const ORCHESTRATOR_NAME = "git-commits-push-tl";
const NOW_EPOCH_MS = 1_800_000_000_000;
const cleanup: string[] = [];

function createFixture(): {
	readonly closureLedgerPath: string;
	readonly runsDirectory: string;
} {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "historical-turnlock-state-"),
	);
	const runsDirectory = path.join(root, "runs");
	fs.mkdirSync(runsDirectory);
	cleanup.push(root);
	return {
		closureLedgerPath: path.join(root, "closure-ledger.json"),
		runsDirectory,
	};
}

function writeRun(
	runsDirectory: string,
	runId: string,
	state: unknown | undefined,
	success: boolean,
): void {
	const runDirectory = path.join(runsDirectory, runId);
	fs.mkdirSync(runDirectory);
	if (state !== undefined) {
		fs.writeFileSync(
			path.join(runDirectory, "state.json"),
			JSON.stringify(state),
		);
	}
	fs.writeFileSync(
		path.join(runDirectory, "events.ndjson"),
		`${JSON.stringify({
			eventType: "orchestrator_end",
			orchestratorName: ORCHESTRATOR_NAME,
			runId,
			success,
		})}\n`,
	);
}

afterEach(() => {
	for (const root of cleanup.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("historical Turnlock state", () => {
	test("rejects invalid state and unsuccessful terminal events", () => {
		const fixture = createFixture();
		const cases = [
			{
				runId: "01J00000000000000000000011",
				state: undefined,
				success: true,
			},
			{
				runId: "01J00000000000000000000012",
				state: {
					orchestratorName: ORCHESTRATOR_NAME,
					runId: "01J00000000000000000000012",
					schemaVersion: 1,
				},
				success: true,
			},
			{
				runId: "01J00000000000000000000013",
				state: {
					orchestratorName: "another-orchestrator",
					runId: "01J00000000000000000000013",
					schemaVersion: 2,
				},
				success: true,
			},
			{
				runId: "01J00000000000000000000014",
				state: {
					orchestratorName: ORCHESTRATOR_NAME,
					runId: "01J00000000000000000000014",
					schemaVersion: 2,
				},
				success: false,
			},
		] as const;
		for (const fixtureCase of cases) {
			writeRun(
				fixture.runsDirectory,
				fixtureCase.runId,
				fixtureCase.state,
				fixtureCase.success,
			);
		}

		const inspection = inspectHistoricalTurnlockState(
			fixture.runsDirectory,
			fixture.closureLedgerPath,
			NOW_EPOCH_MS,
		);

		assert.deepStrictEqual(
			inspection.classifications.map(({ classification }) => classification),
			cases.map(() => "rejected-incompatible"),
		);
		assert.deepStrictEqual(
			inspection.blockers.map(({ kind }) => kind),
			cases.map(() => "incompatible-run"),
		);
		assert.match(inspection.classifications[0]?.reason ?? "", /state\.json/u);
		assert.match(inspection.classifications[1]?.reason ?? "", /schemaVersion/u);
		assert.match(inspection.classifications[2]?.reason ?? "", /identity/u);
		assert.match(inspection.classifications[3]?.reason ?? "", /failure/u);
	});

	test("requires canonical timestamp and ULID closure evidence", () => {
		for (const record of [
			{
				closedAt: "January 1, 2027",
				reason: "non-canonical date",
				runId: "01J00000000000000000000021",
			},
			{
				closedAt: "2027-01-01T00:00:00.000Z",
				reason: "out-of-range identifier",
				runId: "81J00000000000000000000022",
			},
		]) {
			const fixture = createFixture();
			fs.writeFileSync(
				fixture.closureLedgerPath,
				JSON.stringify({ runs: [record], version: 1 }),
			);

			const inspection = inspectHistoricalTurnlockState(
				fixture.runsDirectory,
				fixture.closureLedgerPath,
				NOW_EPOCH_MS,
			);

			assert.deepStrictEqual(
				inspection.blockers.map(({ kind }) => kind),
				["invalid-closure-ledger"],
			);
			assert.deepStrictEqual(inspection.classifications, []);
		}
	});

	test("fails closed when configured historical paths are inaccessible", () => {
		const fixture = createFixture();
		const blockedDirectory = path.join(
			path.dirname(fixture.runsDirectory),
			"blocked",
		);
		const hiddenRunsDirectory = path.join(blockedDirectory, "runs");
		const hiddenLedgerPath = path.join(blockedDirectory, "closures.json");
		fs.mkdirSync(hiddenRunsDirectory, { recursive: true });
		fs.writeFileSync(
			hiddenLedgerPath,
			JSON.stringify({ runs: [], version: 1 }),
		);
		fs.chmodSync(blockedDirectory, 0);
		try {
			const inaccessibleLedger = inspectHistoricalTurnlockState(
				fixture.runsDirectory,
				hiddenLedgerPath,
				NOW_EPOCH_MS,
			);
			assert.deepStrictEqual(
				inaccessibleLedger.blockers.map(({ kind }) => kind),
				["invalid-closure-ledger"],
			);

			const inaccessibleRunRoot = inspectHistoricalTurnlockState(
				hiddenRunsDirectory,
				fixture.closureLedgerPath,
				NOW_EPOCH_MS,
			);
			assert.deepStrictEqual(
				inaccessibleRunRoot.blockers.map(({ kind }) => kind),
				["unreadable-run-root"],
			);
		} finally {
			fs.chmodSync(blockedDirectory, 0o700);
		}
	});
});
