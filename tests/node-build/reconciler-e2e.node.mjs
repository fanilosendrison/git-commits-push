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
const compiledSkillDirectory = path.join(skillDirectory, "dist");
const nodeLauncherPath = path.join(skillDirectory, "scripts", "start-node.mjs");
const mockFetchPreloadPath = path.join(
	testDirectory,
	"fixtures",
	"mock-openai-fetch-reconciler.mjs",
);
const SYNTHETIC_API_KEY = `sk-${"N".repeat(48)}`;

test("E2E | ordinary worktree invocations serialize without scope coalescing", async () => {
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
		await createRepoWithBareRemote(repoB, bareB, environment);
		await writeFile(path.join(repoB, "file3.txt"), "third change\n");
		runGit(repoB, ["add", "file3.txt"], environment);
		const repoBBaseline = runGit(repoB, ["rev-parse", "HEAD"], environment);

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

		// ── Pass 1: the public launcher owns repo A and blocks at the LLM gate ──
		const owner = spawn(process.execPath, [nodeLauncherPath], {
			cwd: repoA,
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
		await waitForFile(firstCallMarker, 240_000);

		// ── A concurrent ordinary invocation from repo B must WAIT, not coalesce ─
		const waiter = spawn(process.execPath, [nodeLauncherPath], {
			cwd: repoB,
			env: {
				...baseEnvironment,
				PI_SESSION_ID: "reconciler-e2e-waiter",
			},
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const waiterClosed = waitForClose(waiter);
		let waiterStdout = "";
		let waiterStderr = "";
		waiter.stdout?.on("data", (chunk) => {
			waiterStdout += chunk.toString("utf8");
		});
		waiter.stderr?.on("data", (chunk) => {
			waiterStderr += chunk.toString("utf8");
		});
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		assert.strictEqual(waiter.exitCode, null, "waiter exited early");
		assert.strictEqual(waiter.signalCode, null, "waiter was signalled early");

		// Before the release, repo B is neither admitted nor executed.
		const beforeRelease = reconcilerDb.openReconcilerDb(dbPath);
		try {
			const state = reconcilerDb.readReconcilerState(beforeRelease);
			assert.strictEqual(state.requestedGeneration, 1);
			assert.strictEqual(state.completedGeneration, 0);
			assert.strictEqual(state.runningGeneration, 1);
			assert.strictEqual(state.ownerPid, owner.pid);
		} finally {
			beforeRelease.close();
		}
		assert.equal(
			runGit(repoB, ["rev-parse", "HEAD"], environment),
			repoBBaseline,
		);
		assert.equal(
			runGit(repoB, ["status", "--porcelain"], environment).includes(
				"file3.txt",
			),
			true,
		);

		// ── Release pass 1; the owner finishes repo A, then the waiter runs B ──
		await writeFile(releaseFile, "");
		const ownerExitCode = await ownerClosed;
		assert.strictEqual(ownerExitCode, 0, `owner stderr: ${ownerStderr}`);
		const waiterExitCode = await waiterClosed;
		assert.strictEqual(waiterExitCode, 0, `waiter stderr: ${waiterStderr}`);

		// ── Git assertions: each exact request published only its own worktree ─
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
		assert.ok(!repoAHistory.includes("publish file3.txt"), repoAHistory);
		const repoBHistory = runGit(repoB, ["log", "--format=%s"], environment);
		assert.ok(repoBHistory.includes("publish file3.txt"), repoBHistory);
		assert.ok(!repoBHistory.includes("publish file1.txt"), repoBHistory);

		// ── Exactly two fresh Turnlock runs, both successful ──────────────────
		const runsDirectory = path.join(turnlockRunRoot, "git-commits-push-tl");
		await waitForRunCompletion(runsDirectory, 2);
		const runEntries = (
			await readdir(runsDirectory, { withFileTypes: true })
		).filter((entry) => entry.isDirectory());
		assert.equal(runEntries.length, 2);

		// ── Two LLM calls: one per exact request ──────────────────────────────
		const requestEvents = await readJsonLines(requestLogPath);
		assert.equal(requestEvents.length, 2, JSON.stringify(requestEvents));
		assert.equal(
			requestEvents.every(({ model }) => model === "gpt-5.4-mini"),
			true,
		);

		// ── Final durable state: converged, idle, no history ──────────────────
		const finalDb = reconcilerDb.openReconcilerDb(dbPath);
		try {
			const state = reconcilerDb.readReconcilerState(finalDb);
			assert.strictEqual(state.requestedGeneration, 2);
			assert.strictEqual(state.completedGeneration, 2);
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
		assert.equal(nonProtocolBytes(waiterStdout), "");
		assert.deepEqual(
			protocolActions(ownerStdout),
			["DONE"],
			`stdout=${ownerStdout}\nstderr=${ownerStderr}`,
		);
		assert.deepEqual(
			protocolActions(waiterStdout),
			["DONE"],
			`stdout=${waiterStdout}\nstderr=${waiterStderr}`,
		);
		for (const secret of [SYNTHETIC_API_KEY]) {
			assert.equal(ownerStdout.includes(secret), false);
			assert.equal(ownerStderr.includes(secret), false);
			assert.equal(waiterStdout.includes(secret), false);
			assert.equal(waiterStderr.includes(secret), false);
		}

		// ── Secret scanning remains active ────────────────────────────────────
		const scannerTelemetry = await readJsonLines(
			path.join(scannerStatsDirectory, "events.jsonl"),
		);
		assert.equal(scannerTelemetry.at(-1)?.eventType, "passed");
	});
});
