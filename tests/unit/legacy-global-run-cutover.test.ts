import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
	assertLegacyGlobalRunCutoverComplete,
	cutoverLegacyGlobalRuns,
	inspectLegacyGlobalRunCutover,
	LEGACY_GLOBAL_REVOCATION_KIND,
} from "../../src/modules/reconciliation/legacy-global-run-cutover.ts";
import { resolveLegacyGlobalRunCutoverPaths } from "../../src/modules/reconciliation/legacy-global-run-paths.ts";

const ORCHESTRATOR_NAME = "git-commits-push-tl";
const GLOBAL_RUN_ID = "01J00000000000000000000031";
const MISSING_SCOPE_RUN_ID = "01J00000000000000000000032";
const TARGETED_RUN_ID = "01J00000000000000000000033";
const WORKTREE_RUN_ID = "01J00000000000000000000034";
const INTERRUPTED_RUN_ID = "01J00000000000000000000035";
const REVOCATION_TIME = "2027-01-15T08:00:00.000Z";
const cleanup: string[] = [];

interface Fixture {
	readonly quarantineDirectory: string;
	readonly root: string;
	readonly runsDirectory: string;
}

function createFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "global-cutover-"));
	const runsDirectory = path.join(root, "runs", ORCHESTRATOR_NAME);
	const quarantineDirectory = path.join(
		root,
		"revoked-runs",
		ORCHESTRATOR_NAME,
	);
	fs.mkdirSync(runsDirectory, { recursive: true });
	cleanup.push(root);
	return { quarantineDirectory, root, runsDirectory };
}

function stateFor(
	runId: string,
	invocationScope:
		| undefined
		| { readonly kind: "global" }
		| { readonly kind: "worktree"; readonly repository: string }
		| {
				readonly kind: "targeted";
				readonly repository: string;
				readonly pushRemote: string;
				readonly pushRef: string;
		  },
): Record<string, unknown> {
	return {
		currentPhase: "commit-and-push",
		data: {
			...(invocationScope === undefined ? {} : { invocationScope }),
			repos: {},
		},
		orchestratorName: ORCHESTRATOR_NAME,
		runId,
		schemaVersion: 2,
	};
}

function writeRun(
	directory: string,
	runId: string,
	state: Record<string, unknown>,
): string {
	const runDirectory = path.join(directory, runId);
	fs.mkdirSync(runDirectory, { recursive: true });
	fs.writeFileSync(
		path.join(runDirectory, "state.json"),
		JSON.stringify(state),
	);
	fs.writeFileSync(path.join(runDirectory, "evidence.bin"), "preserve-me\n");
	return runDirectory;
}

function writeFixtureRuns(fixture: Fixture): void {
	writeRun(
		fixture.runsDirectory,
		GLOBAL_RUN_ID,
		stateFor(GLOBAL_RUN_ID, { kind: "global" }),
	);
	writeRun(
		fixture.runsDirectory,
		MISSING_SCOPE_RUN_ID,
		stateFor(MISSING_SCOPE_RUN_ID, undefined),
	);
	writeRun(
		fixture.runsDirectory,
		TARGETED_RUN_ID,
		stateFor(TARGETED_RUN_ID, {
			kind: "targeted",
			pushRef: "refs/heads/main",
			pushRemote: "origin",
			repository: "/repository-targeted",
		}),
	);
	writeRun(
		fixture.runsDirectory,
		WORKTREE_RUN_ID,
		stateFor(WORKTREE_RUN_ID, {
			kind: "worktree",
			repository: "/repository-worktree",
		}),
	);
}

afterEach(() => {
	for (const root of cleanup.splice(0)) {
		fs.rmSync(root, { force: true, recursive: true });
	}
});

describe("legacy global run cutover", () => {
	test("resolves a same-parent quarantine and rejects relative overrides", () => {
		assert.deepStrictEqual(
			resolveLegacyGlobalRunCutoverPaths({}, "/home/example"),
			{
				quarantineDirectory:
					"/home/example/.turnlock/git-commits-push-revoked-runs/git-commits-push-tl",
				runsDirectory: "/home/example/.turnlock/runs/git-commits-push-tl",
			},
		);
		assert.throws(
			() =>
				resolveLegacyGlobalRunCutoverPaths({
					TURNLOCK_RUN_DIR_ROOT: "relative/runs",
				}),
			/TURNLOCK_RUN_DIR_ROOT must resolve to an absolute path/u,
		);
	});

	test("classifies global compatibility state without mutating the run namespace", () => {
		const fixture = createFixture();
		writeFixtureRuns(fixture);

		const report = inspectLegacyGlobalRunCutover(fixture);

		assert.deepStrictEqual(report, {
			blockers: [],
			candidates: [GLOBAL_RUN_ID, MISSING_SCOPE_RUN_ID],
			ready: false,
			revoked: [],
			safe: [TARGETED_RUN_ID, WORKTREE_RUN_ID],
			version: 1,
		});
		assert.equal(fs.existsSync(fixture.quarantineDirectory), false);
		assert.throws(
			() => assertLegacyGlobalRunCutoverComplete(fixture),
			/legacy global Turnlock runs remain executable/iu,
		);
		assert.equal(
			fs
				.lstatSync(path.join(fixture.runsDirectory, GLOBAL_RUN_ID))
				.isDirectory(),
			true,
		);
	});

	test("atomically removes global runs from the canonical namespace and leaves tombstones", () => {
		const fixture = createFixture();
		writeFixtureRuns(fixture);
		const globalEvidence = fs.readFileSync(
			path.join(fixture.runsDirectory, GLOBAL_RUN_ID, "evidence.bin"),
		);

		const report = cutoverLegacyGlobalRuns({
			...fixture,
			confirmedNoLiveExecution: true,
			revokedAt: REVOCATION_TIME,
		});

		assert.deepStrictEqual(report, {
			blockers: [],
			candidates: [],
			ready: true,
			revoked: [GLOBAL_RUN_ID, MISSING_SCOPE_RUN_ID],
			safe: [TARGETED_RUN_ID, WORKTREE_RUN_ID],
			version: 1,
		});
		for (const runId of [GLOBAL_RUN_ID, MISSING_SCOPE_RUN_ID]) {
			const canonicalPath = path.join(fixture.runsDirectory, runId);
			assert.equal(fs.lstatSync(canonicalPath).isFile(), true);
			assert.deepStrictEqual(
				JSON.parse(fs.readFileSync(canonicalPath, "utf8")),
				{
					kind: LEGACY_GLOBAL_REVOCATION_KIND,
					orchestratorName: ORCHESTRATOR_NAME,
					revokedAt: REVOCATION_TIME,
					runId,
					version: 1,
				},
			);
			assert.equal(
				fs
					.lstatSync(path.join(fixture.quarantineDirectory, runId))
					.isDirectory(),
				true,
			);
		}
		assert.deepStrictEqual(
			fs.readFileSync(
				path.join(fixture.quarantineDirectory, GLOBAL_RUN_ID, "evidence.bin"),
			),
			globalEvidence,
		);
		assert.doesNotThrow(() => assertLegacyGlobalRunCutoverComplete(fixture));
		for (const runId of [TARGETED_RUN_ID, WORKTREE_RUN_ID]) {
			assert.equal(
				fs.lstatSync(path.join(fixture.runsDirectory, runId)).isDirectory(),
				true,
			);
			assert.equal(
				fs.existsSync(path.join(fixture.quarantineDirectory, runId)),
				false,
			);
		}
	});

	test("rejects symlinked run and quarantine namespaces", () => {
		const fixture = createFixture();
		const physicalRuns = path.join(fixture.root, "physical-runs");
		fs.mkdirSync(physicalRuns);
		fs.rmSync(fixture.runsDirectory, { recursive: true });
		fs.symlinkSync(physicalRuns, fixture.runsDirectory);

		assert.deepStrictEqual(
			inspectLegacyGlobalRunCutover(fixture).blockers.map(({ kind }) => kind),
			["unreadable-path"],
		);

		fs.rmSync(fixture.runsDirectory);
		fs.mkdirSync(fixture.runsDirectory);
		const physicalQuarantine = path.join(fixture.root, "physical-quarantine");
		fs.mkdirSync(physicalQuarantine);
		fs.mkdirSync(path.dirname(fixture.quarantineDirectory), {
			recursive: true,
		});
		fs.symlinkSync(physicalQuarantine, fixture.quarantineDirectory);
		assert.deepStrictEqual(
			inspectLegacyGlobalRunCutover(fixture).blockers.map(({ kind }) => kind),
			["unreadable-path"],
		);
	});

	test("recovers a crash after quarantine rename and remains idempotent", () => {
		const fixture = createFixture();
		fs.mkdirSync(fixture.quarantineDirectory, { recursive: true });
		writeRun(
			fixture.quarantineDirectory,
			INTERRUPTED_RUN_ID,
			stateFor(INTERRUPTED_RUN_ID, { kind: "global" }),
		);

		const report = cutoverLegacyGlobalRuns({
			...fixture,
			confirmedNoLiveExecution: true,
			revokedAt: REVOCATION_TIME,
		});
		const repeated = cutoverLegacyGlobalRuns({
			...fixture,
			confirmedNoLiveExecution: true,
			revokedAt: REVOCATION_TIME,
		});

		assert.equal(report.ready, true);
		assert.deepStrictEqual(report.revoked, [INTERRUPTED_RUN_ID]);
		assert.deepStrictEqual(repeated, report);
		assert.equal(
			fs
				.lstatSync(path.join(fixture.runsDirectory, INTERRUPTED_RUN_ID))
				.isFile(),
			true,
		);
	});

	test("requires external no-process confirmation and preserves locked runs", () => {
		const fixture = createFixture();
		const runDirectory = writeRun(
			fixture.runsDirectory,
			GLOBAL_RUN_ID,
			stateFor(GLOBAL_RUN_ID, { kind: "global" }),
		);

		assert.throws(
			() =>
				cutoverLegacyGlobalRuns({
					...fixture,
					confirmedNoLiveExecution: false,
					revokedAt: REVOCATION_TIME,
				}),
			/explicit confirmation that no historical execution is live/u,
		);

		fs.writeFileSync(
			path.join(runDirectory, ".lock"),
			JSON.stringify({ leaseUntilEpochMs: Date.now() + 60_000 }),
		);
		const inspection = inspectLegacyGlobalRunCutover(fixture);
		assert.deepStrictEqual(
			inspection.blockers.map(({ kind }) => kind),
			["turnlock-lock-present"],
		);
		assert.throws(
			() =>
				cutoverLegacyGlobalRuns({
					...fixture,
					confirmedNoLiveExecution: true,
					revokedAt: REVOCATION_TIME,
				}),
			/cutover blockers/u,
		);
		assert.equal(fs.lstatSync(runDirectory).isDirectory(), true);
		assert.equal(fs.existsSync(fixture.quarantineDirectory), false);
	});
});
