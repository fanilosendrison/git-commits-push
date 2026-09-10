import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	startLlmOverlapServer,
	waitForCondition,
} from "./fixtures/execution-lifetime-helpers.mjs";
import {
	createRepoWithBareRemote,
	isolatedEnvironment,
	runGit,
	waitForClose,
	withTemporaryDirectory,
} from "./fixtures/reconciler-e2e-helpers.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "../..");
const compiledSkillDirectory = path.join(skillDirectory, "dist");
const publicLauncherPath = path.join(
	skillDirectory,
	"bin/git-commits-push.mjs",
);
const overlapPreloadPath = path.join(
	testDirectory,
	"fixtures/mock-openai-fetch-overlap.mjs",
);

function processGroupExists(groupId) {
	try {
		process.kill(-groupId, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		if (error.code === "EPERM") return true;
		throw error;
	}
}

async function readEvents(eventsPath) {
	if (!existsSync(eventsPath)) return [];
	return (await readFile(eventsPath, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

test("EXEC-INV-6/7 | supervisor SIGKILL cannot orphan descendants into a fresh pass", {
	skip: process.platform !== "darwin" && process.platform !== "linux",
}, async () => {
	await withTemporaryDirectory(async (root) => {
		const llmServer = await startLlmOverlapServer();
		let owner;
		try {
			const environment = isolatedEnvironment(root);
			await mkdir(environment.HOME, { recursive: true });
			await mkdir(environment.XDG_CONFIG_HOME, { recursive: true });
			const searchRoot = path.join(root, "search root");
			const repositoryPath = path.join(searchRoot, "repository");
			const bareRemotePath = path.join(root, "bare.git");
			await createRepoWithBareRemote(
				repositoryPath,
				bareRemotePath,
				environment,
			);
			await writeFile(path.join(repositoryPath, "pipeline.ts"), "supervisor\n");
			runGit(repositoryPath, ["add", "pipeline.ts"], environment);

			const orderStateDirectory = path.join(root, "reconciler state");
			const executionEventsPath = path.join(root, "execution-events.jsonl");
			const settingsPath = path.join(root, "settings.json");
			for (const directory of [
				orderStateDirectory,
				path.join(root, "turnlock runs"),
				path.join(root, "telemetry"),
				path.join(root, "scanner telemetry"),
			]) {
				await mkdir(directory, { recursive: true });
			}
			await writeFile(executionEventsPath, "");
			await writeFile(
				settingsPath,
				JSON.stringify({
					autoPush: true,
					model: "gpt-5.4-mini",
					provider: "openai",
					searchPaths: [searchRoot],
					skipTests: true,
					systemPromptPath: path.join(
						compiledSkillDirectory,
						"system-prompt.md",
					),
					temperature: 0,
				}),
			);
			const baseEnvironment = {
				...environment,
				GCP_TEST_EXECUTION_EVENTS_PATH: executionEventsPath,
				GCP_TEST_LLM_IGNORE_SIGTERM: "1",
				GCP_TEST_LLM_SERVER_URL: llmServer.url,
				NODE_ENV: "test",
				NODE_OPTIONS: `--import=${pathToFileURL(overlapPreloadPath).href}`,
				OPENAI_API_KEY: "sk-test",
				ORDER_STATE_DIR: orderStateDirectory,
				PI_SESSION_ID: "supervisor-hard-death",
				PI_SKILL_STATS_DIR: path.join(root, "telemetry"),
				SECRET_SCANNER_STATS_DIR: path.join(root, "scanner telemetry"),
				TURNLOCK_RUN_DIR_ROOT: path.join(root, "turnlock runs"),
				TURNLOCK_SKILL_SETTINGS_PATH: settingsPath,
			};
			const reconcilerDb = await import(
				pathToFileURL(
					path.join(
						compiledSkillDirectory,
						"src/modules/reconciliation/reconciler-db.js",
					),
				).href
			);
			const dbPath = reconcilerDb.resolveReconcilerDbPath(orderStateDirectory);

			owner = spawn(process.execPath, [publicLauncherPath], {
				cwd: skillDirectory,
				env: baseEnvironment,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let ownerStderr = "";
			owner.stderr?.on("data", (chunk) => {
				ownerStderr += chunk.toString("utf8");
			});
			const ownerClosed = waitForClose(owner);
			await waitForCondition(
				() => llmServer.events.some(({ type }) => type === "request_opened"),
				"first execution did not reach the LLM barrier",
			);
			await waitForCondition(
				() =>
					readEvents(executionEventsPath).then((events) =>
						events.some(({ type }) => type === "supervisor_started"),
					),
				"supervisor start event was not observed",
			);
			const lifecycleBeforeKill = await readEvents(executionEventsPath);
			const firstSupervisor = lifecycleBeforeKill.find(
				({ type }) => type === "supervisor_started",
			);
			assert.ok(firstSupervisor);
			const firstToken = firstSupervisor.executionToken;
			const firstGroupId = firstSupervisor.groupId;
			process.kill(firstSupervisor.supervisorPid, "SIGKILL");

			await waitForCondition(async () => {
				const events = await readEvents(executionEventsPath);
				return events.some(
					(event) =>
						event.type === "boundary_termination_started" &&
						event.executionToken === firstToken,
				);
			}, "controller did not begin cleanup after supervisor SIGKILL");
			const duringCleanup = reconcilerDb.openReconcilerDb(dbPath);
			try {
				const state = reconcilerDb.readReconcilerState(duringCleanup);
				assert.strictEqual(state.activeExecution?.token, firstToken);
				assert.strictEqual(state.completedGeneration, 0);
			} finally {
				duringCleanup.close();
			}
			assert.strictEqual(processGroupExists(firstGroupId), true);
			assert.strictEqual(llmServer.activeExecutionCount(), 1);
			assert.strictEqual(owner.exitCode, null);

			const followUp = spawn(process.execPath, [publicLauncherPath], {
				cwd: skillDirectory,
				env: { ...baseEnvironment, PI_SESSION_ID: "supervisor-follow-up" },
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let followUpStdout = "";
			followUp.stdout?.on("data", (chunk) => {
				followUpStdout += chunk.toString("utf8");
			});
			assert.strictEqual(await waitForClose(followUp), 0);
			assert.match(
				followUpStdout,
				/Another git-commits-push worker is active/u,
			);

			await waitForCondition(
				() =>
					llmServer.events.filter(({ type }) => type === "request_opened")
						.length === 2,
				"owner did not start the follow-up pass after old boundary cleanup",
			);
			const opened = llmServer.events.filter(
				({ type }) => type === "request_opened",
			);
			assert.notStrictEqual(opened[0].token, opened[1].token);
			const oldCloseIndex = llmServer.events.findIndex(
				(event) =>
					event.type === "request_closed" && event.token === opened[0].token,
			);
			const newOpenIndex = llmServer.events.findIndex(
				(event) =>
					event.type === "request_opened" && event.token === opened[1].token,
			);
			assert.ok(oldCloseIndex >= 0 && oldCloseIndex < newOpenIndex);
			assert.strictEqual(processGroupExists(firstGroupId), false);
			assert.strictEqual(llmServer.overlapDetected(), false);
			assert.strictEqual(llmServer.maximumActiveExecutions(), 1);

			llmServer.release();
			assert.strictEqual(await ownerClosed, 0, ownerStderr);
			const branch = runGit(
				repositoryPath,
				["symbolic-ref", "--quiet", "--short", "HEAD"],
				environment,
			);
			assert.strictEqual(
				runGit(repositoryPath, ["status", "--porcelain"], environment),
				"",
			);
			assert.strictEqual(
				runGit(repositoryPath, ["rev-parse", "HEAD"], environment),
				runGit(
					bareRemotePath,
					["rev-parse", `refs/heads/${branch}`],
					environment,
				),
			);
			const finalDb = reconcilerDb.openReconcilerDb(dbPath);
			try {
				const state = reconcilerDb.readReconcilerState(finalDb);
				assert.strictEqual(state.requestedGeneration, 2);
				assert.strictEqual(state.completedGeneration, 2);
				assert.strictEqual(state.ownerToken, null);
				assert.strictEqual(state.activeExecution, null);
			} finally {
				finalDb.close();
			}
		} finally {
			if (owner && owner.exitCode === null && owner.signalCode === null) {
				owner.kill("SIGKILL");
			}
			await llmServer.close();
		}
	});
});
