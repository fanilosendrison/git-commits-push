import assert, { deepStrictEqual as deepEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
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
import {
	startLlmOverlapServer,
	waitForCondition,
} from "./fixtures/execution-lifetime-helpers.mjs";
import {
	createRepoWithBareRemote,
	isolatedEnvironment,
	nonProtocolBytes,
	protocolActions,
	runGit,
	waitForClose,
	withTemporaryDirectory,
} from "./fixtures/reconciler-e2e-helpers.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "../..");
const compiledSkillDirectory = path.join(skillDirectory, "dist");
const publicLauncherPath = path.join(
	skillDirectory,
	"bin",
	"git-commits-push.mjs",
);
const overlapPreloadPath = path.join(
	testDirectory,
	"fixtures",
	"mock-openai-fetch-overlap.mjs",
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

function processExists(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		if (error.code === "EPERM") return true;
		throw error;
	}
}

function collectOutput(child) {
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	return { stdout: () => stdout, stderr: () => stderr };
}

async function readEvents(eventsPath) {
	if (!existsSync(eventsPath)) return [];
	return (await readFile(eventsPath, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/** An attached ordinary worktree with its own branch and tracked remote. */
async function createAttachedWorktreeFixture(root, environment, name) {
	const canonicalRoot = realpathSync(root);
	const searchRoot = path.join(canonicalRoot, `${name} search`);
	await mkdir(searchRoot, { recursive: true });
	const repositoryPath = path.join(searchRoot, "repository");
	const bareRemotePath = path.join(canonicalRoot, `${name}.git`);
	await createRepoWithBareRemote(repositoryPath, bareRemotePath, environment);
	const baseline = runGit(repositoryPath, ["rev-parse", "HEAD"], environment);
	const branch = `${name}-branch`;
	const taskPath = path.join(searchRoot, "task-worktree");
	runGit(
		repositoryPath,
		["worktree", "add", taskPath, "-b", branch, baseline],
		environment,
	);
	runGit(
		repositoryPath,
		["push", "origin", `${branch}:${branch}`],
		environment,
	);
	runGit(
		taskPath,
		["branch", `--set-upstream-to=origin/${branch}`, branch],
		environment,
	);
	const taskFile = `${name}-task.ts`;
	await writeFile(
		path.join(taskPath, taskFile),
		`export const ${name.replaceAll("-", "_")} = true;\n`,
	);
	runGit(taskPath, ["add", taskFile], environment);
	return {
		bareRemotePath,
		baseline,
		branch,
		pushRef: `refs/heads/${branch}`,
		repositoryPath,
		taskPath,
	};
}

test("EXEC-INV-4/8/10 | a dead ordinary worktree owner is fenced and never replayed", {
	skip: process.platform !== "darwin" && process.platform !== "linux",
}, async () => {
	await withTemporaryDirectory(async (root) => {
		const llmServer = await startLlmOverlapServer();
		let ownerA;
		let ownerB;
		let fixtureRoot = null;
		try {
			const environment = isolatedEnvironment(root);
			await mkdir(environment.HOME, { recursive: true });
			await mkdir(environment.XDG_CONFIG_HOME, { recursive: true });
			// The shared temporary root contains a non-ASCII character whose path
			// normalization differs between Node realpath and Git getcwd. This
			// comparison needs an ASCII-only ancestor chain.
			fixtureRoot = await mkdtemp(path.join(tmpdir(), "worktree-hard-death-"));
			const fixtureA = await createAttachedWorktreeFixture(
				fixtureRoot,
				environment,
				"a",
			);
			const fixtureB = await createAttachedWorktreeFixture(
				fixtureRoot,
				environment,
				"b",
			);

			const orderStateDirectory = path.join(root, "reconciler state");
			const turnlockRunRoot = path.join(root, "turnlock runs");
			const executionEventsPath = path.join(root, "execution-events.jsonl");
			const disconnectBarrier = path.join(root, "never-release-disconnect");
			const settingsPath = path.join(root, "settings.json");
			for (const directory of [
				orderStateDirectory,
				turnlockRunRoot,
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
					searchPaths: [],
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
				GCP_TEST_EXECUTION_DISCONNECT_BARRIER: disconnectBarrier,
				GCP_TEST_EXECUTION_EVENTS_PATH: executionEventsPath,
				GCP_TEST_LLM_SERVER_URL: llmServer.url,
				NODE_ENV: "test",
				NODE_OPTIONS: `--import=${pathToFileURL(overlapPreloadPath).href}`,
				OPENAI_API_KEY: "sk-test",
				ORDER_STATE_DIR: orderStateDirectory,
				PI_SESSION_ID: "worktree-hard-death-a",
				PI_SKILL_STATS_DIR: path.join(root, "telemetry"),
				SECRET_SCANNER_STATS_DIR: path.join(root, "scanner telemetry"),
				TURNLOCK_RUN_DIR_ROOT: turnlockRunRoot,
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

			// ── Ordinary owner from A, no targeted flags, blocked at the LLM gate ──
			ownerA = spawn(process.execPath, [publicLauncherPath], {
				cwd: fixtureA.taskPath,
				env: baseEnvironment,
				shell: false,
				stdio: "ignore",
			});
			await waitForCondition(
				() =>
					llmServer.events.some(
						(event) =>
							event.type === "request_opened" &&
							(event.payload?.files ?? []).includes("a-task.ts"),
					),
				"ordinary owner A did not reach the parent LLM barrier",
			);
			const duringA = reconcilerDb.openReconcilerDb(dbPath);
			let executionA;
			try {
				const state = reconcilerDb.readReconcilerState(duringA);
				assert.strictEqual(state.ownerPid, ownerA.pid);
				// An ordinary worktree request is an exact, non-coalescing request.
				assert.strictEqual(state.ownerInvocationMode, "targeted");
				assert.strictEqual(state.activeExecution?.state, "START_AUTHORIZED");
				executionA = state.activeExecution;
			} finally {
				duringA.close();
			}
			assert.ok(executionA);
			assert.strictEqual(processGroupExists(executionA.groupId), true);

			const ownerAClosed = waitForClose(ownerA);
			ownerA.kill("SIGKILL");
			await ownerAClosed;
			assert.strictEqual(processGroupExists(executionA.groupId), true);

			// ── Ordinary owner from B recovers A's dead boundary, never replays A ─
			ownerB = spawn(process.execPath, [publicLauncherPath], {
				cwd: fixtureB.taskPath,
				env: { ...baseEnvironment, PI_SESSION_ID: "worktree-recovery-owner" },
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const ownerBOutput = collectOutput(ownerB);
			const ownerBClosed = waitForClose(ownerB);
			await waitForCondition(
				() =>
					llmServer.events.some(
						(event) =>
							event.type === "request_opened" &&
							(event.payload?.files ?? []).includes("b-task.ts"),
					),
				"recovery owner did not start its own worktree LLM request",
			);

			// The abandoned boundary is fully resolved before B's supervisor runs.
			assert.strictEqual(processExists(executionA.pid), false);
			assert.strictEqual(processGroupExists(executionA.groupId), false);
			assert.strictEqual(llmServer.overlapDetected(), false);
			assert.strictEqual(llmServer.maximumActiveExecutions(), 1);

			const opened = llmServer.events.filter(
				({ type }) => type === "request_opened",
			);
			assert.strictEqual(opened.length, 2);
			assert.notStrictEqual(opened[0].token, opened[1].token);
			const lifecycle = await readEvents(executionEventsPath);
			assert.strictEqual(
				lifecycle.filter(({ type }) => type === "supervisor_started").length,
				2,
			);
			const oldTerminationIndex = lifecycle.findIndex(
				(event) =>
					event.type === "boundary_termination_started" &&
					event.executionToken === opened[0].token,
			);
			const newSupervisorIndex = lifecycle.findIndex(
				(event) =>
					event.type === "supervisor_started" &&
					event.executionToken === opened[1].token,
			);
			assert.ok(
				oldTerminationIndex >= 0 && oldTerminationIndex < newSupervisorIndex,
			);

			// Generation 1 was A's abandoned request, generation 2 the recovery
			// settlement, and generation 3 B's own exact request.
			const settlingDb = reconcilerDb.openReconcilerDb(dbPath);
			try {
				const state = reconcilerDb.readReconcilerState(settlingDb);
				assert.strictEqual(state.requestedGeneration, 3);
				assert.strictEqual(state.completedGeneration, 2);
				assert.strictEqual(state.runningGeneration, 3);
				assert.strictEqual(state.ownerInvocationMode, "targeted");
			} finally {
				settlingDb.close();
			}
			// A's abandoned scope was never replayed: A stays at baseline.
			assert.strictEqual(
				runGit(fixtureA.taskPath, ["rev-parse", "HEAD"], environment),
				fixtureA.baseline,
			);
			assert.strictEqual(
				runGit(
					fixtureA.bareRemotePath,
					["rev-parse", fixtureA.pushRef],
					environment,
				),
				fixtureA.baseline,
			);

			llmServer.release();
			assert.strictEqual(await ownerBClosed, 0, ownerBOutput.stderr());

			const finalDb = reconcilerDb.openReconcilerDb(dbPath);
			try {
				const state = reconcilerDb.readReconcilerState(finalDb);
				assert.strictEqual(state.requestedGeneration, 3);
				assert.strictEqual(state.completedGeneration, 3);
				assert.strictEqual(state.runningGeneration, null);
				assert.strictEqual(state.ownerToken, null);
				assert.strictEqual(state.ownerInvocationMode, null);
				assert.strictEqual(state.activeExecution, null);
			} finally {
				finalDb.close();
			}
			// B published only B; A stays byte-identically at baseline.
			const headB = runGit(
				fixtureB.taskPath,
				["rev-parse", "HEAD"],
				environment,
			);
			assert.notStrictEqual(headB, fixtureB.baseline);
			assert.strictEqual(
				runGit(
					fixtureB.bareRemotePath,
					["rev-parse", fixtureB.pushRef],
					environment,
				),
				headB,
			);
			assert.strictEqual(
				runGit(fixtureB.taskPath, ["status", "--porcelain"], environment),
				"",
			);
			assert.strictEqual(
				runGit(fixtureA.taskPath, ["rev-parse", "HEAD"], environment),
				fixtureA.baseline,
			);
			assert.strictEqual(
				runGit(
					fixtureA.bareRemotePath,
					["rev-parse", fixtureA.pushRef],
					environment,
				),
				fixtureA.baseline,
			);
			const stateEntries = await readdir(orderStateDirectory);
			assert.strictEqual(
				stateEntries.some(
					(name) => name === "running.lock" || name.startsWith("order-"),
				),
				false,
			);
			assert.strictEqual(nonProtocolBytes(ownerBOutput.stdout()), "");
			deepEqual(protocolActions(ownerBOutput.stdout()), ["DELEGATE", "DONE"]);
		} finally {
			if (ownerA && ownerA.exitCode === null && ownerA.signalCode === null) {
				ownerA.kill("SIGKILL");
			}
			if (ownerB && ownerB.exitCode === null && ownerB.signalCode === null) {
				ownerB.kill("SIGKILL");
			}
			if (fixtureRoot !== null) {
				await rm(fixtureRoot, { force: true, recursive: true });
			}
			await llmServer.close();
		}
	});
});

async function createDetachedTarget(root, environment, name) {
	const canonicalRoot = realpathSync(root);
	const searchRoot = path.join(canonicalRoot, `${name} search`);
	await mkdir(searchRoot, { recursive: true });
	const repositoryPath = path.join(searchRoot, "repository");
	const bareRemotePath = path.join(canonicalRoot, `${name}.git`);
	await createRepoWithBareRemote(repositoryPath, bareRemotePath, environment);
	const baseline = runGit(repositoryPath, ["rev-parse", "HEAD"], environment);
	const branch = runGit(
		repositoryPath,
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		environment,
	);
	const taskPath = path.join(searchRoot, "task-worktree");
	runGit(
		repositoryPath,
		["worktree", "add", "--detach", taskPath, baseline],
		environment,
	);
	await writeFile(
		path.join(taskPath, `${name}-task.ts`),
		`export const ${name.replaceAll("-", "_")} = true;\n`,
	);
	return {
		bareRemotePath,
		baseline,
		branch,
		pushRef: `refs/heads/${branch}`,
		taskPath,
	};
}

function targetedLauncherArguments(target) {
	return [
		"--repository",
		target.taskPath,
		"--push-remote",
		"origin",
		"--push-ref",
		target.pushRef,
	];
}

test("EXEC-INV-4/8/10 | a dead targeted owner is fenced and never replayed", {
	skip: process.platform !== "darwin" && process.platform !== "linux",
}, async () => {
	await withTemporaryDirectory(async (root) => {
		const llmServer = await startLlmOverlapServer();
		let ownerA;
		let ownerB;
		let fixtureRoot = null;
		try {
			const environment = isolatedEnvironment(root);
			await mkdir(environment.HOME, { recursive: true });
			await mkdir(environment.XDG_CONFIG_HOME, { recursive: true });
			// The shared temporary root contains a non-ASCII character whose path
			// normalization differs between Node realpath and Git getcwd. This
			// targeted worktree comparison needs an ASCII-only ancestor chain.
			fixtureRoot = await mkdtemp(path.join(tmpdir(), "targeted-hard-death-"));
			const targetA = await createDetachedTarget(fixtureRoot, environment, "a");
			const targetB = await createDetachedTarget(fixtureRoot, environment, "b");
			const orderStateDirectory = path.join(root, "reconciler state");
			const turnlockRunRoot = path.join(root, "turnlock runs");
			const executionEventsPath = path.join(root, "execution-events.jsonl");
			const settingsPath = path.join(root, "settings.json");
			for (const directory of [
				orderStateDirectory,
				turnlockRunRoot,
				path.join(root, "telemetry"),
				path.join(root, "scanner telemetry"),
			]) {
				await mkdir(directory, { recursive: true });
			}
			await writeFile(executionEventsPath, "");
			await writeFile(
				settingsPath,
				JSON.stringify({
					autoPush: false,
					model: "gpt-5.4-mini",
					provider: "openai",
					searchPaths: [],
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
				GCP_TEST_LLM_SERVER_URL: llmServer.url,
				NODE_ENV: "test",
				NODE_OPTIONS: `--import=${pathToFileURL(overlapPreloadPath).href}`,
				OPENAI_API_KEY: "sk-test",
				ORDER_STATE_DIR: orderStateDirectory,
				PI_SESSION_ID: "targeted-hard-death-a",
				PI_SKILL_STATS_DIR: path.join(root, "telemetry"),
				SECRET_SCANNER_STATS_DIR: path.join(root, "scanner telemetry"),
				TURNLOCK_RUN_DIR_ROOT: turnlockRunRoot,
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

			ownerA = spawn(
				process.execPath,
				[publicLauncherPath, ...targetedLauncherArguments(targetA)],
				{
					cwd: skillDirectory,
					env: baseEnvironment,
					shell: false,
					stdio: "ignore",
				},
			);
			await waitForCondition(
				() =>
					llmServer.events.some(
						(event) =>
							event.type === "request_opened" &&
							(event.payload?.files ?? []).includes("a-task.ts"),
					),
				"targeted owner A did not reach the LLM barrier",
			);
			const duringA = reconcilerDb.openReconcilerDb(dbPath);
			let executionA;
			try {
				const state = reconcilerDb.readReconcilerState(duringA);
				assert.strictEqual(state.ownerPid, ownerA.pid);
				assert.strictEqual(state.ownerInvocationMode, "targeted");
				assert.strictEqual(state.activeExecution?.state, "START_AUTHORIZED");
				executionA = state.activeExecution;
			} finally {
				duringA.close();
			}
			assert.ok(executionA);
			assert.strictEqual(processGroupExists(executionA.groupId), true);

			const ownerAClosed = waitForClose(ownerA);
			ownerA.kill("SIGKILL");
			await ownerAClosed;
			assert.strictEqual(processGroupExists(executionA.groupId), true);

			ownerB = spawn(
				process.execPath,
				[publicLauncherPath, ...targetedLauncherArguments(targetB)],
				{
					cwd: skillDirectory,
					env: { ...baseEnvironment, PI_SESSION_ID: "targeted-recovery-owner" },
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			const ownerBOutput = collectOutput(ownerB);
			const ownerBClosed = waitForClose(ownerB);
			await waitForCondition(
				() =>
					llmServer.events.some(
						(event) =>
							event.type === "request_opened" &&
							(event.payload?.files ?? []).includes("b-task.ts"),
					),
				"recovery owner did not start its own targeted LLM request",
			);

			// The abandoned boundary is fully resolved before the new owner runs.
			assert.strictEqual(processExists(executionA.pid), false);
			assert.strictEqual(processGroupExists(executionA.groupId), false);
			assert.strictEqual(llmServer.overlapDetected(), false);
			assert.strictEqual(llmServer.maximumActiveExecutions(), 1);

			const opened = llmServer.events.filter(
				({ type }) => type === "request_opened",
			);
			assert.strictEqual(opened.length, 2);
			assert.notStrictEqual(opened[0].token, opened[1].token);
			const lifecycle = await readEvents(executionEventsPath);
			assert.strictEqual(
				lifecycle.filter(({ type }) => type === "supervisor_started").length,
				2,
			);
			const oldTerminationIndex = lifecycle.findIndex(
				(event) =>
					event.type === "boundary_termination_started" &&
					event.executionToken === opened[0].token,
			);
			const newSupervisorIndex = lifecycle.findIndex(
				(event) =>
					event.type === "supervisor_started" &&
					event.executionToken === opened[1].token,
			);
			assert.ok(
				oldTerminationIndex >= 0 && oldTerminationIndex < newSupervisorIndex,
			);

			// Recovery settled generation 2 before the new request claimed 3, and
			// the dead target was never replayed.
			const settlingDb = reconcilerDb.openReconcilerDb(dbPath);
			try {
				const state = reconcilerDb.readReconcilerState(settlingDb);
				assert.strictEqual(state.requestedGeneration, 3);
				assert.strictEqual(state.completedGeneration, 2);
				assert.strictEqual(state.runningGeneration, 3);
				assert.strictEqual(state.ownerInvocationMode, "targeted");
			} finally {
				settlingDb.close();
			}
			assert.strictEqual(
				runGit(targetA.taskPath, ["rev-parse", "HEAD"], environment),
				targetA.baseline,
			);
			assert.strictEqual(
				runGit(
					targetA.bareRemotePath,
					["rev-parse", targetA.pushRef],
					environment,
				),
				targetA.baseline,
			);

			llmServer.release();
			assert.strictEqual(await ownerBClosed, 0, ownerBOutput.stderr());

			const finalDb = reconcilerDb.openReconcilerDb(dbPath);
			try {
				const state = reconcilerDb.readReconcilerState(finalDb);
				assert.strictEqual(state.requestedGeneration, 3);
				assert.strictEqual(state.completedGeneration, 3);
				assert.strictEqual(state.runningGeneration, null);
				assert.strictEqual(state.ownerToken, null);
				assert.strictEqual(state.ownerInvocationMode, null);
				assert.strictEqual(state.activeExecution, null);
			} finally {
				finalDb.close();
			}
			const targetBHead = runGit(
				targetB.taskPath,
				["rev-parse", "HEAD"],
				environment,
			);
			assert.notStrictEqual(targetBHead, targetB.baseline);
			assert.strictEqual(
				runGit(
					targetB.bareRemotePath,
					["rev-parse", targetB.pushRef],
					environment,
				),
				targetBHead,
			);
			assert.strictEqual(
				runGit(targetA.taskPath, ["rev-parse", "HEAD"], environment),
				targetA.baseline,
			);
			assert.strictEqual(
				runGit(
					targetA.bareRemotePath,
					["rev-parse", targetA.pushRef],
					environment,
				),
				targetA.baseline,
			);
			assert.strictEqual(nonProtocolBytes(ownerBOutput.stdout()), "");
			deepEqual(protocolActions(ownerBOutput.stdout()), ["DELEGATE", "DONE"]);
		} finally {
			if (ownerA && ownerA.exitCode === null && ownerA.signalCode === null) {
				ownerA.kill("SIGKILL");
			}
			if (ownerB && ownerB.exitCode === null && ownerB.signalCode === null) {
				ownerB.kill("SIGKILL");
			}
			if (fixtureRoot !== null) {
				await rm(fixtureRoot, { force: true, recursive: true });
			}
			await llmServer.close();
		}
	});
});
