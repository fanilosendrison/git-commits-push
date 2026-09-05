import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createRepoWithBareRemote,
	isolatedEnvironment,
	nonProtocolBytes,
	protocolActions,
	readJsonLines,
	runGit,
	waitForClose,
	waitForFile,
	waitForRunCompletion,
	withTemporaryDirectory,
} from "./fixtures/reconciler-e2e-helpers.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "../..");
const compiledSkillDirectory = path.join(
	skillDirectory,
	"dist",
	"skills",
	"git-commits-push",
);
const nodeLauncherPath = path.join(skillDirectory, "scripts", "start-node.mjs");
const mockFetchPreloadPath = path.join(
	testDirectory,
	"fixtures",
	"mock-openai-fetch-reconciler.mjs",
);
const SYNTHETIC_API_KEY = `sk-${"N".repeat(48)}`;

test("E2E | global rescan coalesces concurrent requests into one fresh pass", async () => {
	await withTemporaryDirectory(async (root) => {
		const environment = isolatedEnvironment(root);
		await mkdir(environment.HOME, { recursive: true });
		await mkdir(environment.XDG_CONFIG_HOME, { recursive: true });

		const searchRoot = path.join(root, "search root 漢字");
		const repoA = path.join(searchRoot, "repo-a");
		const bareA = path.join(root, "bare-a.git");
		const repoB = path.join(searchRoot, "repo-b");
		const bareB = path.join(root, "bare-b.git");
		await createRepoWithBareRemote(repoA, bareA, environment);
		await writeFile(path.join(repoA, "file1.txt"), "first change\n");
		runGit(repoA, ["add", "file1.txt"], environment);

		const turnlockRunRoot = path.join(root, "turnlock runs é");
		const orderStateDirectory = path.join(root, "reconciler state 漢字");
		const statsDirectory = path.join(root, "pipeline telemetry é");
		const scannerStatsDirectory = path.join(root, "scanner telemetry 漢字");
		const enforcerStatsDirectory = path.join(root, "enforcer telemetry é");
		const requestLogPath = path.join(root, "mock LLM requests.jsonl");
		const firstCallMarker = path.join(root, "first-call.marker");
		const releaseFile = path.join(root, "release");
		const settingsPath = path.join(root, "settings with spaces.json");
		for (const directory of [
			turnlockRunRoot,
			orderStateDirectory,
			statsDirectory,
			scannerStatsDirectory,
			enforcerStatsDirectory,
		]) {
			await mkdir(directory, { recursive: true });
		}
		await writeFile(
			settingsPath,
			JSON.stringify({
				agent: "git-commits-push",
				autoPush: true,
				model: "gpt-5.4-mini",
				provider: "openai",
				searchPaths: [searchRoot],
				skipTests: true,
				systemPromptPath: path.join(compiledSkillDirectory, "system-prompt.md"),
				temperature: 0,
			}),
		);

		const baseEnvironment = {
			...environment,
			GIT_COMMITS_PUSH_ENFORCER_STATS_DIR: enforcerStatsDirectory,
			MOCK_LLM_FIRST_CALL_MARKER: firstCallMarker,
			MOCK_LLM_RELEASE_FILE: releaseFile,
			MOCK_LLM_REQUEST_LOG: requestLogPath,
			NODE_OPTIONS: `--import=${pathToFileURL(mockFetchPreloadPath).href}`,
			OPENAI_API_KEY: SYNTHETIC_API_KEY,
			ORDER_STATE_DIR: orderStateDirectory,
			PI_PARENT_MODEL: "reconciler-parent-model",
			PI_SESSION_ID: "reconciler-e2e-owner",
			PI_SKILL_STATS_DIR: statsDirectory,
			SECRET_SCANNER_STATS_DIR: scannerStatsDirectory,
			TURNLOCK_RUN_DIR_ROOT: turnlockRunRoot,
			TURNLOCK_SKILL_SETTINGS_PATH: settingsPath,
		};

		// ── Pass 1: the public launcher owns reconciliation and blocks at LLM ──
		const owner = spawn(process.execPath, [nodeLauncherPath], {
			cwd: skillDirectory,
			env: baseEnvironment,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const ownerClosed = waitForClose(owner);
		let ownerStdout = "";
		let ownerStderr = "";
		owner.stdout?.on("data", (chunk) => {
			ownerStdout += chunk.toString("utf8");
		});
		owner.stderr?.on("data", (chunk) => {
			ownerStderr += chunk.toString("utf8");
		});
		// The barrier sits AFTER pass 1's global discovery, at the LLM boundary.
		await waitForFile(firstCallMarker, 240_000);

		// ── While pass 1 is blocked: redirty repo-a and create repo-b ────────
		await writeFile(path.join(repoA, "file2.txt"), "second change\n");
		await createRepoWithBareRemote(repoB, bareB, environment);
		await writeFile(path.join(repoB, "file3.txt"), "third change\n");

		// ── Concurrent public invocations coalesce and exit before any build ──
		const concurrentLaunchers = [];
		for (let index = 0; index < 3; index++) {
			const launcher = spawn(process.execPath, [nodeLauncherPath], {
				cwd: skillDirectory,
				env: {
					...baseEnvironment,
					PI_SESSION_ID: `reconciler-e2e-concurrent-${index}`,
				},
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			launcher.stdout?.on("data", (chunk) => {
				stdout += chunk.toString("utf8");
			});
			concurrentLaunchers.push({ launcher, stdout: () => stdout });
		}
		for (const { launcher } of concurrentLaunchers) {
			const exitCode = await waitForClose(launcher);
			assert.strictEqual(exitCode, 0);
		}
		for (const { stdout } of concurrentLaunchers) {
			assert.ok(
				stdout().includes("Another git-commits-push worker is active"),
				`expected a coalesced message, got: ${stdout()}`,
			);
		}

		// Before the release, the durable state holds all four generations.
		const reconcilerDb = await import(
			pathToFileURL(
				path.join(
					compiledSkillDirectory,
					"src",
					"modules",
					"reconciliation",
					"reconciler-db.js",
				),
			).href
		);
		const dbPath = reconcilerDb.resolveReconcilerDbPath(orderStateDirectory);
		const beforeRelease = reconcilerDb.openReconcilerDb(dbPath);
		try {
			const state = reconcilerDb.readReconcilerState(beforeRelease);
			assert.strictEqual(state.requestedGeneration, 4);
			assert.strictEqual(state.completedGeneration, 0);
			assert.strictEqual(state.runningGeneration, 1);
			assert.strictEqual(state.ownerPid, owner.pid);
		} finally {
			beforeRelease.close();
		}

		// ── Release pass 1 and wait for the owner to drain every generation ──
		await writeFile(releaseFile, "");
		const ownerExitCode = await ownerClosed;
		assert.strictEqual(ownerExitCode, 0, `owner stderr: ${ownerStderr}`);

		// ── Git assertions ─────────────────────────────────────────────────────
		const branchA = runGit(
			repoA,
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			environment,
		);
		const branchB = runGit(
			repoB,
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			environment,
		);
		assert.equal(runGit(repoA, ["status", "--porcelain"], environment), "");
		assert.equal(runGit(repoB, ["status", "--porcelain"], environment), "");
		assert.equal(
			runGit(repoA, ["rev-parse", "HEAD"], environment),
			runGit(bareA, ["rev-parse", `refs/heads/${branchA}`], environment),
		);
		assert.equal(
			runGit(repoB, ["rev-parse", "HEAD"], environment),
			runGit(bareB, ["rev-parse", `refs/heads/${branchB}`], environment),
		);
		const repoAHistory = runGit(repoA, ["log", "--format=%s"], environment);
		assert.ok(repoAHistory.includes("publish file1.txt"), repoAHistory);
		assert.ok(repoAHistory.includes("publish file2.txt"), repoAHistory);
		const repoBHistory = runGit(repoB, ["log", "--format=%s"], environment);
		assert.ok(repoBHistory.includes("publish file3.txt"), repoBHistory);

		// ── Exactly two fresh Turnlock runs, both successful ──────────────────
		const runsDirectory = path.join(turnlockRunRoot, "git-commits-push-tl");
		await waitForRunCompletion(runsDirectory, 2);
		const runEntries = (
			await readdir(runsDirectory, { withFileTypes: true })
		).filter((entry) => entry.isDirectory());
		assert.equal(runEntries.length, 2);

		// ── Three LLM calls: one for pass 1, two for pass 2 ───────────────────
		const requestEvents = await readJsonLines(requestLogPath);
		assert.equal(requestEvents.length, 3, JSON.stringify(requestEvents));
		assert.equal(
			requestEvents.every(({ model }) => model === "gpt-5.4-mini"),
			true,
		);

		// ── Final durable state: converged, idle, no history ──────────────────
		const finalDb = reconcilerDb.openReconcilerDb(dbPath);
		try {
			const state = reconcilerDb.readReconcilerState(finalDb);
			assert.strictEqual(state.requestedGeneration, 4);
			assert.strictEqual(state.completedGeneration, 4);
			assert.strictEqual(state.runningGeneration, null);
			assert.strictEqual(state.ownerToken, null);
			assert.strictEqual(state.ownerPid, null);
			assert.deepStrictEqual(reconcilerDb.listReconcilerTables(finalDb), [
				"reconciler_state",
			]);
			assert.strictEqual(reconcilerDb.countReconcilerStateRows(finalDb), 1);
		} finally {
			finalDb.close();
		}

		// ── No legacy queue artifacts; only the SQLite coordinator ────────────
		const stateEntries = await readdir(orderStateDirectory);
		assert.equal(
			stateEntries.some(
				(name) => name === "running.lock" || name.startsWith("order-"),
			),
			false,
		);

		// ── Turnlock stdout protocol cleanliness ───────────────────────────────
		assert.equal(nonProtocolBytes(ownerStdout), "");
		assert.deepEqual(
			protocolActions(ownerStdout),
			["DONE", "DONE"],
			`stdout=${ownerStdout}\nstderr=${ownerStderr}`,
		);
		for (const secret of [SYNTHETIC_API_KEY]) {
			assert.equal(ownerStdout.includes(secret), false);
			assert.equal(ownerStderr.includes(secret), false);
		}

		// ── Secret scanning remains active ────────────────────────────────────
		const scannerTelemetry = await readJsonLines(
			path.join(scannerStatsDirectory, "events.jsonl"),
		);
		assert.equal(scannerTelemetry.at(-1)?.eventType, "passed");
	});
});
