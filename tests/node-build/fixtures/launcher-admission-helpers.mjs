/**
 * Shared fixtures and launcher-spawn helpers for the launcher admission and
 * targeted-serialization node build tests. Extracted so each test file stays
 * within the per-file test timeout budget.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRepoWithBareRemote } from "./reconciler-e2e-helpers.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
export const skillDirectory = path.resolve(testDirectory, "../../..");
export const compiledSkillDirectory = path.join(skillDirectory, "dist");
export const nodeLauncherPath = path.join(
	skillDirectory,
	"scripts",
	"start-node.mjs",
);
export const mockFetchPreloadPath = path.join(
	testDirectory,
	"mock-openai-fetch-reconciler.mjs",
);
export const overlapPreloadPath = path.join(
	testDirectory,
	"mock-openai-fetch-overlap.mjs",
);

export async function withTemporaryDirectory(callback) {
	const directory = await mkdtemp(path.join(tmpdir(), "launcher-admission-"));
	try {
		await callback(directory);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

export function isolatedEnvironment(root) {
	return {
		...process.env,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		HOME: path.join(root, "isolated home"),
		XDG_CONFIG_HOME: path.join(root, "isolated config"),
	};
}

export function runGit(cwd, args, environment) {
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

export async function waitForFile(filePath, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(filePath)) {
		assert.ok(Date.now() < deadline, `timed out waiting for ${filePath}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

export function waitForClose(child) {
	return new Promise((resolve) => {
		child.once("close", (code) => resolve(code));
	});
}

export function waitForCloseOutcome(child) {
	return new Promise((resolve) => {
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
}

export async function writeLauncherSettings(root, searchPaths) {
	const settingsPath = path.join(root, "settings.json");
	await writeFile(
		settingsPath,
		JSON.stringify({
			agent: "git-commits-push",
			autoPush: false,
			model: "gpt-5.4-mini",
			provider: "openai",
			searchPaths,
			skipTests: true,
			systemPromptPath: path.join(compiledSkillDirectory, "system-prompt.md"),
			temperature: 0,
		}),
	);
	return settingsPath;
}

export async function prepareLauncherRoot(root, environment) {
	await mkdir(environment.HOME, { recursive: true });
	await mkdir(environment.XDG_CONFIG_HOME, { recursive: true });
	const orderStateDirectory = path.join(root, "reconciler state");
	const executionEventsPath = path.join(root, "execution-events.jsonl");
	for (const directory of [
		orderStateDirectory,
		path.join(root, "telemetry"),
		path.join(root, "scanner telemetry"),
		path.join(root, "turnlock runs"),
	]) {
		await mkdir(directory, { recursive: true });
	}
	await writeFile(executionEventsPath, "");
	return {
		dbPath: path.join(orderStateDirectory, "reconciler.sqlite"),
		executionEventsPath,
		orderStateDirectory,
	};
}

export function launcherEnvironment(
	root,
	environment,
	llmServer,
	settingsPath,
	extra,
) {
	return {
		...environment,
		GCP_TEST_EXECUTION_EVENTS_PATH: path.join(root, "execution-events.jsonl"),
		GCP_TEST_LLM_SERVER_URL: llmServer.url,
		NODE_ENV: "test",
		NODE_OPTIONS: `--import=${pathToFileURL(overlapPreloadPath).href}`,
		OPENAI_API_KEY: "sk-test",
		ORDER_STATE_DIR: path.join(root, "reconciler state"),
		PI_SKILL_STATS_DIR: path.join(root, "telemetry"),
		SECRET_SCANNER_STATS_DIR: path.join(root, "scanner telemetry"),
		TURNLOCK_RUN_DIR_ROOT: path.join(root, "turnlock runs"),
		TURNLOCK_SKILL_SETTINGS_PATH: settingsPath,
		TURNLOCK_TEST: "0",
		...extra,
	};
}

export function spawnLauncher(
	environment,
	argumentsList = [],
	cwd = skillDirectory,
) {
	const child = spawn(process.execPath, [nodeLauncherPath, ...argumentsList], {
		cwd,
		env: environment,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	return { child, stderr: () => stderr, stdout: () => stdout };
}

export async function createTargetFixture(root, environment, name) {
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
		repositoryPath,
		searchRoot,
		taskPath,
	};
}

export function targetedArguments(target) {
	return [
		"--repository",
		target.taskPath,
		"--push-remote",
		"origin",
		"--push-ref",
		target.pushRef,
	];
}

/** A clean attached ordinary invocation worktree with its own bare remote. */
export async function createOrdinaryFixture(root, environment, name) {
	const canonicalRoot = realpathSync(root);
	const repositoryPath = path.join(canonicalRoot, `${name} worktree`);
	const bareRemotePath = path.join(canonicalRoot, `${name}.git`);
	await createRepoWithBareRemote(repositoryPath, bareRemotePath, environment);
	return { bareRemotePath, repositoryPath };
}

export function readReconcilerRow(dbPath) {
	const probe = new DatabaseSync(dbPath);
	try {
		return probe
			.prepare(
				"SELECT requested_generation AS requestedGeneration, completed_generation AS completedGeneration, running_generation AS runningGeneration, owner_token AS ownerToken, owner_pid AS ownerPid, owner_invocation_mode AS ownerInvocationMode, execution_token AS executionToken, execution_state AS executionState FROM reconciler_state WHERE singleton_id = 1",
			)
			.get();
	} finally {
		probe.close();
	}
}

export async function readReconcilerRowEventually(
	dbPath,
	predicate,
	timeoutMs = 90_000,
) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const row = readReconcilerRow(dbPath);
			if (row !== undefined && predicate(row)) return row;
		} catch (error) {
			const message = String(error);
			if (
				!message.includes("database is locked") &&
				!message.includes("no such table: reconciler_state")
			) {
				throw error;
			}
		}
		assert.ok(
			Date.now() < deadline,
			`timed out reading reconciler state at ${dbPath}`,
		);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

export async function readExecutionEvents(eventsPath) {
	if (!existsSync(eventsPath)) return [];
	return (await readFile(eventsPath, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

export function registeredExecutionTokens(events) {
	return new Set(
		events
			.filter(({ type }) => type === "launcher_execution_registered")
			.map(({ executionToken }) => executionToken),
	);
}

export async function observeStableWait(waiter, dbPath, expected) {
	// Observe a real interval: the waiter must stay alive, must not mutate the
	// coordinator row, and must not start any Git-capable execution.
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	assert.strictEqual(waiter.child.exitCode, null, "waiter exited early");
	assert.strictEqual(
		waiter.child.signalCode,
		null,
		"waiter was signalled early",
	);
	const row = readReconcilerRow(dbPath);
	assert.strictEqual(row.requestedGeneration, expected.requestedGeneration);
	assert.strictEqual(row.runningGeneration, expected.runningGeneration);
	assert.strictEqual(row.ownerToken, expected.ownerToken);
	assert.strictEqual(row.executionToken, expected.executionToken);
}
