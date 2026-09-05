import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createRepoWithBareRemote,
	isolatedEnvironment,
	runGit,
	waitForClose,
	waitForFile,
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

test("fenced heartbeat cancels active work without completing its generation", async () => {
	await withTemporaryDirectory(async (root) => {
		const environment = isolatedEnvironment(root);
		await mkdir(environment.HOME, { recursive: true });
		await mkdir(environment.XDG_CONFIG_HOME, { recursive: true });
		const searchRoot = path.join(root, "search root");
		const repositoryPath = path.join(searchRoot, "repository");
		await createRepoWithBareRemote(
			repositoryPath,
			path.join(root, "remote.git"),
			environment,
		);
		await writeFile(path.join(repositoryPath, "pending.txt"), "pending\n");
		runGit(repositoryPath, ["add", "pending.txt"], environment);

		const orderStateDirectory = path.join(root, "reconciler state");
		const firstCallMarker = path.join(root, "first-call.marker");
		const releaseFile = path.join(root, "never-release");
		const settingsPath = path.join(root, "settings.json");
		for (const directory of [
			orderStateDirectory,
			path.join(root, "turnlock runs"),
			path.join(root, "telemetry"),
			path.join(root, "scanner telemetry"),
		]) {
			await mkdir(directory, { recursive: true });
		}
		await writeFile(
			settingsPath,
			JSON.stringify({
				autoPush: false,
				model: "gpt-5.4-mini",
				provider: "openai",
				searchPaths: [searchRoot],
				skipTests: true,
				systemPromptPath: path.join(compiledSkillDirectory, "system-prompt.md"),
				temperature: 0,
			}),
		);
		const launcher = spawn(process.execPath, [nodeLauncherPath], {
			cwd: skillDirectory,
			env: {
				...environment,
				MOCK_LLM_FIRST_CALL_MARKER: firstCallMarker,
				MOCK_LLM_RELEASE_FILE: releaseFile,
				MOCK_LLM_REQUEST_LOG: path.join(root, "requests.jsonl"),
				NODE_OPTIONS: `--import=${pathToFileURL(mockFetchPreloadPath).href}`,
				OPENAI_API_KEY: "sk-test",
				ORDER_STATE_DIR: orderStateDirectory,
				PI_SESSION_ID: "heartbeat-fencing",
				PI_SKILL_STATS_DIR: path.join(root, "telemetry"),
				SECRET_SCANNER_STATS_DIR: path.join(root, "scanner telemetry"),
				TURNLOCK_RUN_DIR_ROOT: path.join(root, "turnlock runs"),
				TURNLOCK_SKILL_SETTINGS_PATH: settingsPath,
			},
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		launcher.stderr?.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		const closed = waitForClose(launcher);
		await waitForFile(firstCallMarker, 240_000);

		const dbPath = path.join(orderStateDirectory, "reconciler.sqlite");
		const attacker = new DatabaseSync(dbPath);
		try {
			attacker.exec(
				"UPDATE reconciler_state SET owner_token = 'replacement-owner-token' WHERE singleton_id = 1",
			);
		} finally {
			attacker.close();
		}

		assert.strictEqual(await closed, 2, stderr);
		assert.match(stderr, /ownership was lost/u);
		const verification = new DatabaseSync(dbPath);
		try {
			const state = verification
				.prepare(
					"SELECT requested_generation AS requestedGeneration, completed_generation AS completedGeneration, running_generation AS runningGeneration, owner_token AS ownerToken FROM reconciler_state WHERE singleton_id = 1",
				)
				.get();
			assert.strictEqual(state.requestedGeneration, 1);
			assert.strictEqual(state.completedGeneration, 0);
			assert.strictEqual(state.runningGeneration, 1);
			assert.strictEqual(state.ownerToken, "replacement-owner-token");
		} finally {
			verification.close();
		}
	});
});
