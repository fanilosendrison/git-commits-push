import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
	const directory = await mkdtemp(path.join(tmpdir(), "reconciler-failure-é-"));
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

test("E2E | failed reconciliation is not acknowledged and recovers later", async () => {
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
		runGit(
			repositoryPath,
			["config", "user.name", "Failure Recovery"],
			environment,
		);
		runGit(
			repositoryPath,
			["config", "user.email", "failure-recovery@example.invalid"],
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

		// A dirty change carrying a production-looking secret: validation fails.
		await writeFile(
			path.join(repositoryPath, "pipeline.ts"),
			'const AWS_KEY = "AKIA1234567890ABCDEF";\n',
		);
		runGit(repositoryPath, ["add", "pipeline.ts"], environment);

		const turnlockRunRoot = path.join(root, "turnlock runs");
		const orderStateDirectory = path.join(root, "reconciler state");
		const statsDirectory = path.join(root, "telemetry");
		const scannerStatsDirectory = path.join(root, "scanner telemetry");
		const requestLogPath = path.join(root, "requests.jsonl");
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
			MOCK_LLM_REQUEST_LOG: requestLogPath,
			NODE_OPTIONS: `--import=${pathToFileURL(mockFetchPreloadPath).href}`,
			OPENAI_API_KEY: "sk-test",
			ORDER_STATE_DIR: orderStateDirectory,
			PI_SESSION_ID: "failure-recovery",
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

		// ── Pass 1: validation fails ─────────────────────────────────────────
		const failedRun = spawnSync(process.execPath, [nodeLauncherPath], {
			cwd: skillDirectory,
			encoding: "utf8",
			env: baseEnvironment,
			shell: false,
			timeout: 240_000,
		});
		assert.notStrictEqual(failedRun.status, 0);

		const afterFailure = reconcilerDb.openReconcilerDb(dbPath);
		try {
			const state = reconcilerDb.readReconcilerState(afterFailure);
			assert.strictEqual(state.requestedGeneration, 1);
			assert.strictEqual(state.completedGeneration, 0);
			assert.strictEqual(state.ownerToken, null);
			assert.strictEqual(state.runningGeneration, null);
		} finally {
			afterFailure.close();
		}
		// Nothing was committed.
		assert.match(
			runGit(repositoryPath, ["status", "--porcelain"], environment),
			/pipeline\.ts/,
		);

		// ── Fix the repo and invoke the launcher again ───────────────────────
		await writeFile(
			path.join(repositoryPath, "pipeline.ts"),
			"export const recovered = true;\n",
		);
		const recoveryRun = spawnSync(process.execPath, [nodeLauncherPath], {
			cwd: skillDirectory,
			encoding: "utf8",
			env: baseEnvironment,
			shell: false,
			timeout: 240_000,
		});
		assert.equal(recoveryRun.status, 0, recoveryRun.stderr);

		const afterRecovery = reconcilerDb.openReconcilerDb(dbPath);
		try {
			const state = reconcilerDb.readReconcilerState(afterRecovery);
			assert.strictEqual(state.requestedGeneration, 2);
			assert.strictEqual(state.completedGeneration, 2);
			assert.strictEqual(state.ownerToken, null);
			assert.strictEqual(state.runningGeneration, null);
		} finally {
			afterRecovery.close();
		}

		// The repo is clean and the remote received the commit.
		assert.equal(
			runGit(repositoryPath, ["status", "--porcelain"], environment),
			"",
		);
		const branchName = runGit(
			repositoryPath,
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			environment,
		);
		assert.equal(
			runGit(repositoryPath, ["rev-parse", "HEAD"], environment),
			runGit(
				bareRemotePath,
				["rev-parse", `refs/heads/${branchName}`],
				environment,
			),
		);
		assert.match(
			runGit(repositoryPath, ["log", "-1", "--pretty=%s"], environment),
			/^feat: publish pipeline\.ts$/,
		);

		// The successful pass made exactly one LLM call.
		const requestLines = (await readFile(requestLogPath, "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean);
		assert.equal(requestLines.length, 1);
	});
});
