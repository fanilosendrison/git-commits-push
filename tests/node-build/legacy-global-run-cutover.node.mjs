import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "../..");
const cutoverScript = path.join(
	skillDirectory,
	"scripts",
	"cutover-legacy-global-runs.mjs",
);
const installerScript = path.join(
	skillDirectory,
	"scripts",
	"install-standalone.mjs",
);
const ORCHESTRATOR_NAME = "git-commits-push-tl";
const GLOBAL_RUN_ID = "01J00000000000000000000041";
const TARGETED_RUN_ID = "01J00000000000000000000042";

function stateFor(runId, invocationScope) {
	return {
		currentPhase: "commit-and-push",
		data: { invocationScope, repos: {} },
		orchestratorName: ORCHESTRATOR_NAME,
		runId,
		schemaVersion: 2,
	};
}

function writeRun(runsDirectory, runId, state) {
	const runDirectory = path.join(runsDirectory, runId);
	mkdirSync(runDirectory, { recursive: true });
	writeFileSync(path.join(runDirectory, "state.json"), JSON.stringify(state));
	writeFileSync(path.join(runDirectory, "evidence.bin"), "preserved\n");
}

function invoke(scriptArguments, environment) {
	return spawnSync(process.execPath, [cutoverScript, ...scriptArguments], {
		cwd: skillDirectory,
		encoding: "utf8",
		env: environment,
		shell: false,
	});
}

test("source cutover CLI revokes global runs and blocks a captured historical lookup", () => {
	const root = mkdtempSync(path.join(tmpdir(), "legacy-global-cli-é-"));
	try {
		const turnlockRoot = path.join(root, "turnlock runs");
		const runsDirectory = path.join(turnlockRoot, ORCHESTRATOR_NAME);
		const quarantineDirectory = path.join(
			root,
			"revoked-runs",
			ORCHESTRATOR_NAME,
		);
		mkdirSync(runsDirectory, { recursive: true });
		writeRun(
			runsDirectory,
			GLOBAL_RUN_ID,
			stateFor(GLOBAL_RUN_ID, { kind: "global" }),
		);
		writeRun(
			runsDirectory,
			TARGETED_RUN_ID,
			stateFor(TARGETED_RUN_ID, {
				kind: "targeted",
				pushRef: "refs/heads/main",
				pushRemote: "origin",
				repository: "/targeted-repository",
			}),
		);
		const environment = {
			...process.env,
			GCP_LEGACY_GLOBAL_QUARANTINE: quarantineDirectory,
			HOME: root,
			TURNLOCK_RUN_DIR_ROOT: turnlockRoot,
			XDG_STATE_HOME: path.join(root, "state"),
		};

		const dryRun = invoke([], environment);
		assert.equal(dryRun.status, 1, dryRun.stderr);
		const dryReport = JSON.parse(dryRun.stdout);
		assert.deepEqual(dryReport.report.candidates, [GLOBAL_RUN_ID]);
		assert.equal(
			lstatSync(path.join(runsDirectory, GLOBAL_RUN_ID)).isDirectory(),
			true,
		);
		const blockedInstaller = spawnSync(process.execPath, [installerScript], {
			cwd: skillDirectory,
			encoding: "utf8",
			env: { ...environment, npm_execpath: process.execPath },
			shell: false,
		});
		assert.notEqual(blockedInstaller.status, 0);
		assert.match(
			blockedInstaller.stderr,
			/legacy global Turnlock runs remain executable/iu,
		);

		const unconfirmed = invoke(["--apply"], environment);
		assert.equal(unconfirmed.status, 2);
		assert.match(unconfirmed.stderr, /confirm-no-live-execution/u);

		const applied = invoke(
			["--apply", "--confirm-no-live-execution"],
			environment,
		);
		assert.equal(applied.status, 0, applied.stderr);
		const appliedReport = JSON.parse(applied.stdout);
		assert.deepEqual(appliedReport.report.revoked, [GLOBAL_RUN_ID]);
		assert.equal(
			lstatSync(path.join(runsDirectory, GLOBAL_RUN_ID)).isFile(),
			true,
		);
		assert.equal(
			lstatSync(path.join(quarantineDirectory, GLOBAL_RUN_ID)).isDirectory(),
			true,
		);
		assert.equal(
			lstatSync(path.join(runsDirectory, TARGETED_RUN_ID)).isDirectory(),
			true,
		);
		assert.equal(
			readFileSync(
				path.join(quarantineDirectory, GLOBAL_RUN_ID, "evidence.bin"),
				"utf8",
			),
			"preserved\n",
		);

		const effectMarker = path.join(root, "historical-effect.marker");
		const historicalLookup = spawnSync(
			process.execPath,
			[
				"-e",
				"const fs=require('node:fs');const path=require('node:path');const run=process.argv[1];fs.readFileSync(path.join(run,'state.json'));fs.writeFileSync(process.argv[2],'effect');",
				path.join(runsDirectory, GLOBAL_RUN_ID),
				effectMarker,
			],
			{ encoding: "utf8", shell: false },
		);
		assert.notEqual(historicalLookup.status, 0);
		assert.equal(
			spawnSync(process.execPath, [
				"-e",
				"process.exit(require('node:fs').existsSync(process.argv[1])?1:0)",
				effectMarker,
			]).status,
			0,
		);

		const repeated = invoke(
			["--apply", "--confirm-no-live-execution"],
			environment,
		);
		assert.equal(repeated.status, 0, repeated.stderr);
		assert.deepEqual(JSON.parse(repeated.stdout).report, appliedReport.report);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

const historicalReleaseDirectories = (
	process.env.GCP_QUALIFY_LEGACY_RELEASES ?? ""
)
	.split(path.delimiter)
	.filter(Boolean);

test("exact historical release entrypoints cannot reopen a revoked global run", {
	skip: historicalReleaseDirectories.length === 0,
}, () => {
	const root = mkdtempSync(path.join(tmpdir(), "legacy-release-cutover-é-"));
	try {
		const turnlockRoot = path.join(root, ".turnlock", "runs");
		const runsDirectory = path.join(turnlockRoot, ORCHESTRATOR_NAME);
		const quarantineDirectory = path.join(
			root,
			".turnlock",
			"git-commits-push-revoked-runs",
			ORCHESTRATOR_NAME,
		);
		mkdirSync(runsDirectory, { recursive: true });
		writeRun(
			runsDirectory,
			GLOBAL_RUN_ID,
			stateFor(GLOBAL_RUN_ID, { kind: "global" }),
		);
		const environment = {
			...process.env,
			GCP_LEGACY_GLOBAL_QUARANTINE: quarantineDirectory,
			HOME: root,
			TURNLOCK_RUN_DIR_ROOT: turnlockRoot,
			XDG_STATE_HOME: path.join(root, "state"),
		};
		const applied = invoke(
			["--apply", "--confirm-no-live-execution"],
			environment,
		);
		assert.equal(applied.status, 0, applied.stderr);

		for (const releaseDirectory of historicalReleaseDirectories) {
			const orchestratorPath = path.join(
				releaseDirectory,
				"dist",
				"src",
				"entrypoints",
				"turnlock-orchestrator.js",
			);
			assert.equal(existsSync(orchestratorPath), true, orchestratorPath);
			const resumed = spawnSync(
				process.execPath,
				[orchestratorPath, "--run-id", GLOBAL_RUN_ID, "--resume"],
				{
					cwd: releaseDirectory,
					encoding: "utf8",
					env: environment,
					shell: false,
				},
			);
			assert.match(
				`${resumed.stdout}\n${resumed.stderr}`,
				/ENOTDIR|state|RUN_DIR/iu,
			);
			assert.equal(
				lstatSync(path.join(runsDirectory, GLOBAL_RUN_ID)).isFile(),
				true,
			);
		}
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});
