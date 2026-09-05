import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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

async function withTemporaryDirectory(callback) {
	const directory = await mkdtemp(
		path.join(tmpdir(), "reconciler-hard-death-é-"),
	);
	try {
		await callback(directory);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

function isolatedEnvironment(root) {
	return {
		...process.env,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		HOME: path.join(root, "isolated home"),
		XDG_CONFIG_HOME: path.join(root, "isolated config"),
	};
}

function runGit(cwd, args, environment) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: environment,
		shell: false,
	});
	assert.equal(
		result.status,
		0,
		`git ${args.join(" ")} failed: ${result.stderr}`,
	);
	return result.stdout.trim();
}

async function waitForFile(filePath, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(filePath)) {
		assert.ok(Date.now() < deadline, `timed out waiting for ${filePath}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

async function waitForRunCompletion(runsDirectory, expectedRuns) {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		const entries = existsSync(runsDirectory)
			? await readdir(runsDirectory, { withFileTypes: true })
			: [];
		const runs = entries.filter((entry) => entry.isDirectory());
		if (runs.length !== expectedRuns) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			continue;
		}
		let allTerminal = true;
		for (const run of runs) {
			const eventsPath = path.join(runsDirectory, run.name, "events.ndjson");
			if (!existsSync(eventsPath)) {
				allTerminal = false;
				continue;
			}
			const lines = (await readFile(eventsPath, "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			if (lines.at(-1)?.eventType !== "orchestrator_end") {
				allTerminal = false;
			}
		}
		if (allTerminal) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.fail("Turnlock runs did not reach terminal state in time");
}

function waitForClose(child) {
	return new Promise((resolve) => {
		child.once("close", (code) => resolve(code));
	});
}

test("E2E | hard owner death leaves durable state and recovers cleanly", async () => {
	await withTemporaryDirectory(async (root) => {
		const environment = isolatedEnvironment(root);
		await mkdir(environment.HOME, { recursive: true });
		await mkdir(environment.XDG_CONFIG_HOME, { recursive: true });

		const searchRoot = path.join(root, "search root");
		const repositoryPath = path.join(searchRoot, "repository");
		const bareRemotePath = path.join(root, "bare.git");
		await mkdir(repositoryPath, { recursive: true });
		await mkdir(bareRemotePath, { recursive: true });
		runGit(bareRemotePath, ["init", "--bare", "--quiet"], environment);
		runGit(repositoryPath, ["init", "--quiet"], environment);
		runGit(repositoryPath, ["config", "user.name", "Hard Death"], environment);
		runGit(
			repositoryPath,
			["config", "user.email", "hard-death@example.invalid"],
			environment,
		);
		await writeFile(path.join(repositoryPath, "README.md"), "initial\n");
		runGit(repositoryPath, ["add", "README.md"], environment);
		runGit(
			repositoryPath,
			["commit", "--quiet", "--no-verify", "-m", "initial"],
			environment,
		);
		runGit(
			repositoryPath,
			["remote", "add", "origin", bareRemotePath],
			environment,
		);
		runGit(
			repositoryPath,
			["push", "--quiet", "--set-upstream", "origin", "HEAD"],
			environment,
		);
		await writeFile(path.join(repositoryPath, "pipeline.ts"), "hard death\n");
		runGit(repositoryPath, ["add", "pipeline.ts"], environment);

		const turnlockRunRoot = path.join(root, "turnlock runs");
		const orderStateDirectory = path.join(root, "reconciler state");
		const statsDirectory = path.join(root, "telemetry");
		const scannerStatsDirectory = path.join(root, "scanner telemetry");
		const requestLogPath = path.join(root, "requests.jsonl");
		const firstCallMarker = path.join(root, "first-call.marker");
		const releaseFile = path.join(root, "release");
		const settingsPath = path.join(root, "settings.json");
		for (const directory of [
			turnlockRunRoot,
			orderStateDirectory,
			statsDirectory,
			scannerStatsDirectory,
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
			MOCK_LLM_FIRST_CALL_MARKER: firstCallMarker,
			MOCK_LLM_RELEASE_FILE: releaseFile,
			MOCK_LLM_REQUEST_LOG: requestLogPath,
			NODE_OPTIONS: `--import=${pathToFileURL(mockFetchPreloadPath).href}`,
			OPENAI_API_KEY: "sk-test",
			ORDER_STATE_DIR: orderStateDirectory,
			PI_SESSION_ID: "hard-death",
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

		// ── Owner A acquires state, builds, and blocks at the LLM barrier ────
		const ownerA = spawn(process.execPath, [nodeLauncherPath], {
			cwd: skillDirectory,
			env: baseEnvironment,
			shell: false,
			// Ignore output so a SIGKILL cannot leave an orphaned supervisor
			// holding the test process's pipe endpoints open.
			stdio: ["ignore", "ignore", "ignore"],
		});
		const ownerAClosed = waitForClose(ownerA);
		await waitForFile(firstCallMarker, 240_000);

		const duringRun = reconcilerDb.openReconcilerDb(dbPath);
		try {
			const state = reconcilerDb.readReconcilerState(duringRun);
			assert.strictEqual(state.requestedGeneration, 1);
			assert.strictEqual(state.completedGeneration, 0);
			assert.strictEqual(state.runningGeneration, 1);
			assert.strictEqual(state.ownerPid, ownerA.pid);
		} finally {
			duringRun.close();
		}

		// ── Hard death: SIGKILL the launcher without any graceful cleanup ─────
		const ownerPid = ownerA.pid;
		assert.notStrictEqual(ownerPid, undefined);
		ownerA.kill("SIGKILL");
		await ownerAClosed;
		assert.strictEqual(existsSync(dbPath), true);

		const afterDeath = reconcilerDb.openReconcilerDb(dbPath);
		try {
			const state = reconcilerDb.readReconcilerState(afterDeath);
			assert.strictEqual(state.requestedGeneration, 1);
			assert.strictEqual(state.completedGeneration, 0);
			assert.strictEqual(state.runningGeneration, 1);
			assert.strictEqual(state.ownerPid, ownerPid);
		} finally {
			afterDeath.close();
		}

		// The orphaned pipeline finishes its Git work once released; the dead
		// launcher never finalizes SQLite.
		await writeFile(releaseFile, "");
		const runsDirectory = path.join(turnlockRunRoot, "git-commits-push-tl");
		await waitForRunCompletion(runsDirectory, 1);
		const branchName = runGit(
			repositoryPath,
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			environment,
		);
		assert.equal(
			runGit(repositoryPath, ["status", "--porcelain"], environment),
			"",
		);
		assert.equal(
			runGit(repositoryPath, ["rev-parse", "HEAD"], environment),
			runGit(
				bareRemotePath,
				["rev-parse", `refs/heads/${branchName}`],
				environment,
			),
		);

		// ── The next public invocation detects the dead owner and recovers ────
		const recoveryEnvironment = {
			...baseEnvironment,
			MOCK_LLM_FIRST_CALL_MARKER: undefined,
			MOCK_LLM_RELEASE_FILE: undefined,
		};
		const recovery = spawnSync(process.execPath, [nodeLauncherPath], {
			cwd: skillDirectory,
			encoding: "utf8",
			env: recoveryEnvironment,
			shell: false,
			timeout: 240_000,
		});
		assert.equal(recovery.status, 0, recovery.stderr);
		assert.ok(
			recovery.stderr.includes(
				"recovered reconciliation state from a previous owner",
			),
			recovery.stderr,
		);

		const finalDb = reconcilerDb.openReconcilerDb(dbPath);
		try {
			const state = reconcilerDb.readReconcilerState(finalDb);
			// requested advanced monotonically: the database was never reset.
			assert.strictEqual(state.requestedGeneration, 2);
			assert.strictEqual(state.completedGeneration, 2);
			assert.strictEqual(state.runningGeneration, null);
			assert.strictEqual(state.ownerToken, null);
		} finally {
			finalDb.close();
		}

		// The orphaned pass and the recovering launcher each have their own
		// durable Turnlock run; the killed launcher itself launched no extra run.
		const runEntries = (
			await readdir(runsDirectory, { withFileTypes: true })
		).filter((entry) => entry.isDirectory());
		assert.equal(runEntries.length, 2);
	});
});
