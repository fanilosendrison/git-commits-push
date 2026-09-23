import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
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
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	startLlmOverlapServer,
	waitForCondition,
} from "./fixtures/execution-lifetime-helpers.mjs";
import { createRepoWithBareRemote } from "./fixtures/reconciler-e2e-helpers.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "../..");
const compiledSkillDirectory = path.join(skillDirectory, "dist");
const nodeLauncherPath = path.join(skillDirectory, "scripts", "start-node.mjs");
const mockFetchPreloadPath = path.join(
	testDirectory,
	"fixtures",
	"mock-openai-fetch-reconciler.mjs",
);
const overlapPreloadPath = path.join(
	testDirectory,
	"fixtures",
	"mock-openai-fetch-overlap.mjs",
);

async function withTemporaryDirectory(callback) {
	const directory = await mkdtemp(path.join(tmpdir(), "launcher-admission-"));
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

function waitForClose(child) {
	return new Promise((resolve) => {
		child.once("close", (code) => resolve(code));
	});
}

function waitForCloseOutcome(child) {
	return new Promise((resolve) => {
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
}

async function writeLauncherSettings(root, searchPaths) {
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

async function prepareLauncherRoot(root, environment) {
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

function launcherEnvironment(
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

function spawnLauncher(environment, argumentsList = []) {
	const child = spawn(process.execPath, [nodeLauncherPath, ...argumentsList], {
		cwd: skillDirectory,
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

async function createTargetFixture(root, environment, name) {
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

function targetedArguments(target) {
	return [
		"--repository",
		target.taskPath,
		"--push-remote",
		"origin",
		"--push-ref",
		target.pushRef,
	];
}

function readReconcilerRow(dbPath) {
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

async function readReconcilerRowEventually(
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

async function readExecutionEvents(eventsPath) {
	if (!existsSync(eventsPath)) return [];
	return (await readFile(eventsPath, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function registeredExecutionTokens(events) {
	return new Set(
		events
			.filter(({ type }) => type === "launcher_execution_registered")
			.map(({ executionToken }) => executionToken),
	);
}

async function observeStableWait(waiter, dbPath, expected) {
	// Observe a real interval: the waiter must stay alive, must not mutate the
	// coordinator row, and must not start any Git-capable execution.
	await new Promise((resolve) => setTimeout(resolve, 2_000));
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

test("I0 | SIGTERM during build releases ownership without completion", async () => {
	await withTemporaryDirectory(async (root) => {
		const environment = isolatedEnvironment(root);
		await mkdir(environment.HOME, { recursive: true });
		await mkdir(environment.XDG_CONFIG_HOME, { recursive: true });
		const orderStateDirectory = path.join(root, "reconciler state");
		const settingsPath = path.join(root, "settings.json");
		await mkdir(orderStateDirectory, { recursive: true });
		await writeFile(
			settingsPath,
			JSON.stringify({
				autoPush: false,
				model: "gpt-5.4-mini",
				provider: "openai",
				searchPaths: [],
				skipTests: true,
				systemPromptPath: "/dev/null",
				temperature: 0,
			}),
		);
		const launcher = spawn(process.execPath, [nodeLauncherPath], {
			cwd: skillDirectory,
			env: {
				...environment,
				ORDER_STATE_DIR: orderStateDirectory,
				PI_SESSION_ID: "signal-during-build",
				TURNLOCK_SKILL_SETTINGS_PATH: settingsPath,
			},
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const closed = new Promise((resolve) => {
			launcher.once("close", (code, signal) => resolve({ code, signal }));
		});
		const dbPath = path.join(orderStateDirectory, "reconciler.sqlite");
		await waitForFile(dbPath, 60_000);
		const deadline = Date.now() + 30_000;
		while (true) {
			const probe = new DatabaseSync(dbPath);
			let ownerToken;
			try {
				ownerToken = probe
					.prepare(
						"SELECT owner_token AS ownerToken FROM reconciler_state WHERE singleton_id = 1",
					)
					.get()?.ownerToken;
			} catch (error) {
				const message = String(error);
				if (
					!message.includes("database is locked") &&
					!message.includes("no such table: reconciler_state")
				) {
					throw error;
				}
			} finally {
				probe.close();
			}
			if (ownerToken) break;
			assert.ok(Date.now() < deadline, "owner admission timed out");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		launcher.kill("SIGTERM");
		const outcome = await closed;
		assert.strictEqual(outcome.signal, "SIGTERM");
		const verification = new DatabaseSync(dbPath);
		try {
			const state = verification
				.prepare(
					"SELECT requested_generation AS requestedGeneration, completed_generation AS completedGeneration, owner_token AS ownerToken FROM reconciler_state WHERE singleton_id = 1",
				)
				.get();
			assert.strictEqual(state.requestedGeneration, 1);
			assert.strictEqual(state.completedGeneration, 0);
			assert.strictEqual(state.ownerToken, null);
		} finally {
			verification.close();
		}
	});
});

test("I1 | coalesced launcher admissions exit 0 before any build", async () => {
	await withTemporaryDirectory(async (root) => {
		const environment = isolatedEnvironment(root);
		await mkdir(environment.HOME, { recursive: true });
		await mkdir(environment.XDG_CONFIG_HOME, { recursive: true });

		const searchRoot = path.join(root, "search root");
		const repositoryPath = path.join(searchRoot, "repository");
		await mkdir(repositoryPath, { recursive: true });
		runGit(repositoryPath, ["init", "--quiet"], environment);
		runGit(
			repositoryPath,
			["config", "user.name", "Admission Test"],
			environment,
		);
		runGit(
			repositoryPath,
			["config", "user.email", "admission@example.invalid"],
			environment,
		);
		await writeFile(path.join(repositoryPath, "README.md"), "initial\n");
		runGit(repositoryPath, ["add", "README.md"], environment);
		runGit(
			repositoryPath,
			["commit", "--quiet", "--no-verify", "-m", "initial"],
			environment,
		);
		await writeFile(path.join(repositoryPath, "pipeline.ts"), "admission\n");
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
				autoPush: false,
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
			PI_SESSION_ID: "admission-owner",
			PI_SKILL_STATS_DIR: statsDirectory,
			SECRET_SCANNER_STATS_DIR: scannerStatsDirectory,
			TURNLOCK_RUN_DIR_ROOT: turnlockRunRoot,
			TURNLOCK_SKILL_SETTINGS_PATH: settingsPath,
		};

		// The owner builds dist and then blocks at the LLM barrier.
		const owner = spawn(process.execPath, [nodeLauncherPath], {
			cwd: skillDirectory,
			env: baseEnvironment,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const ownerClosed = waitForClose(owner);
		let ownerStderr = "";
		owner.stderr?.on("data", (chunk) => {
			ownerStderr += chunk.toString("utf8");
		});
		await waitForFile(firstCallMarker, 240_000);

		// The build is complete; snapshot dist and drop a sentinel.
		const supervisorArtifact = path.join(
			compiledSkillDirectory,
			"src",
			"entrypoints",
			"node-supervisor.js",
		);
		assert.equal(existsSync(supervisorArtifact), true);
		const artifactMtime = statSync(supervisorArtifact).mtimeMs;
		const sentinelPath = path.join(
			skillDirectory,
			"dist",
			"admission-sentinel.marker",
		);
		writeFileSync(sentinelPath, "owner built this dist\n");

		// A concurrent public invocation must coalesce WITHOUT building.
		const coalesced = spawnSync(process.execPath, [nodeLauncherPath], {
			cwd: skillDirectory,
			encoding: "utf8",
			env: { ...baseEnvironment, PI_SESSION_ID: "admission-coalesced" },
			shell: false,
			timeout: 60_000,
		});
		assert.equal(coalesced.status, 0, coalesced.stderr);
		assert.ok(
			coalesced.stdout.includes("Another git-commits-push worker is active"),
			coalesced.stdout,
		);
		assert.ok(
			existsSync(sentinelPath),
			"a coalesced caller must never reach the build step",
		);
		assert.equal(statSync(supervisorArtifact).mtimeMs, artifactMtime);

		// Release the owner; it finishes its single pass and converges.
		writeFileSync(releaseFile, "");
		const ownerExitCode = await ownerClosed;
		assert.strictEqual(ownerExitCode, 0, ownerStderr);

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
		const db = reconcilerDb.openReconcilerDb(
			reconcilerDb.resolveReconcilerDbPath(orderStateDirectory),
		);
		try {
			const state = reconcilerDb.readReconcilerState(db);
			assert.strictEqual(state.requestedGeneration, 2);
			assert.strictEqual(state.completedGeneration, 2);
			assert.strictEqual(state.ownerToken, null);
		} finally {
			db.close();
		}

		// Two fresh passes belong to the owner; the coalesced caller launched
		// nothing of its own.
		const runsDirectory = path.join(turnlockRunRoot, "git-commits-push-tl");
		const runEntries = (
			await readdir(runsDirectory, { withFileTypes: true })
		).filter((entry) => entry.isDirectory());
		assert.equal(runEntries.length, 2);

		// The sentinel is only removed by the NEXT full build — assert it
		// survived the whole owner lifecycle (build once, no rebuild).
		assert.equal(existsSync(sentinelPath), true);
		const stateEntries = await readdir(orderStateDirectory);
		assert.equal(
			stateEntries.some(
				(name) => name === "running.lock" || name.startsWith("order-"),
			),
			false,
		);
		// The second fresh pass observes the clean repository and needs no LLM
		// request; only the first pass has work to plan.
		const requestLines = (await readFile(requestLogPath, "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean);
		assert.equal(requestLines.length, 1);
	});
});

async function advanceBareRemote(root, target, environment) {
	const clonePath = path.join(root, "advance-clone");
	runGit(
		root,
		["clone", "--quiet", target.bareRemotePath, clonePath],
		environment,
	);
	runGit(
		clonePath,
		["config", "user.email", "advance@example.invalid"],
		environment,
	);
	runGit(clonePath, ["config", "user.name", "Advance"], environment);
	await writeFile(
		path.join(clonePath, "advanced.ts"),
		"export const advanced = true;\n",
	);
	runGit(clonePath, ["add", "advanced.ts"], environment);
	runGit(
		clonePath,
		["commit", "--quiet", "--no-verify", "-m", "advance"],
		environment,
	);
	runGit(
		clonePath,
		["push", "--quiet", "origin", `HEAD:${target.pushRef}`],
		environment,
	);
	return runGit(clonePath, ["rev-parse", "HEAD"], environment);
}

test("W2 | a targeted request waits for a global owner, then runs its exact scope", async () => {
	await withTemporaryDirectory(async (root) => {
		const llmServer = await startLlmOverlapServer();
		let owner = null;
		let waiter = null;
		try {
			const environment = isolatedEnvironment(root);
			const prepared = await prepareLauncherRoot(root, environment);
			const globalRoot = path.join(root, "global search");
			const globalRepository = path.join(globalRoot, "repository");
			await createRepoWithBareRemote(
				globalRepository,
				path.join(root, "global.git"),
				environment,
			);
			await writeFile(
				path.join(globalRepository, "global.ts"),
				"export const globalWork = true;\n",
			);
			runGit(globalRepository, ["add", "global.ts"], environment);
			const target = await createTargetFixture(root, environment, "b");
			const settingsPath = await writeLauncherSettings(root, [globalRoot]);

			owner = spawnLauncher(
				launcherEnvironment(root, environment, llmServer, settingsPath, {
					PI_SESSION_ID: "global-owner",
				}),
			);
			await waitForCondition(
				() => llmServer.events.some(({ type }) => type === "request_opened"),
				"global owner did not reach the LLM barrier",
			);
			const ownerRow = await readReconcilerRowEventually(
				prepared.dbPath,
				(row) => row.executionState === "START_AUTHORIZED",
			);
			assert.strictEqual(ownerRow.ownerInvocationMode, "global");

			waiter = spawnLauncher(
				launcherEnvironment(root, environment, llmServer, settingsPath, {
					PI_SESSION_ID: "targeted-waiter",
				}),
				targetedArguments(target),
			);
			await observeStableWait(waiter, prepared.dbPath, {
				executionToken: ownerRow.executionToken,
				ownerToken: ownerRow.ownerToken,
				requestedGeneration: ownerRow.requestedGeneration,
				runningGeneration: ownerRow.runningGeneration,
			});
			const events = await readExecutionEvents(prepared.executionEventsPath);
			assert.deepStrictEqual(
				[...registeredExecutionTokens(events)],
				[ownerRow.executionToken],
			);
			assert.strictEqual(llmServer.overlapDetected(), false);
			assert.strictEqual(llmServer.maximumActiveExecutions(), 1);

			llmServer.release();
			assert.strictEqual(await waitForClose(owner.child), 0, owner.stderr());
			assert.strictEqual(await waitForClose(waiter.child), 0, waiter.stderr());

			const finalRow = readReconcilerRow(prepared.dbPath);
			assert.strictEqual(finalRow.requestedGeneration, 2);
			assert.strictEqual(finalRow.completedGeneration, 2);
			assert.strictEqual(finalRow.runningGeneration, null);
			assert.strictEqual(finalRow.ownerToken, null);
			assert.strictEqual(finalRow.ownerInvocationMode, null);
			assert.strictEqual(finalRow.executionToken, null);

			const targetHead = runGit(
				target.taskPath,
				["rev-parse", "HEAD"],
				environment,
			);
			assert.notStrictEqual(targetHead, target.baseline);
			assert.strictEqual(
				runGit(
					target.bareRemotePath,
					["rev-parse", target.pushRef],
					environment,
				),
				targetHead,
			);
		} finally {
			for (const record of [owner, waiter]) {
				if (
					record !== null &&
					record.child.exitCode === null &&
					record.child.signalCode === null
				) {
					record.child.kill("SIGKILL");
				}
			}
			await llmServer.close();
		}
	});
});

test("W3 | a global request waits for a targeted owner, then executes globally", async () => {
	await withTemporaryDirectory(async (root) => {
		const llmServer = await startLlmOverlapServer();
		let owner = null;
		let waiter = null;
		try {
			const environment = isolatedEnvironment(root);
			const prepared = await prepareLauncherRoot(root, environment);
			const target = await createTargetFixture(root, environment, "a");
			const emptySearchRoot = path.join(root, "empty search");
			await mkdir(emptySearchRoot, { recursive: true });
			const settingsPath = await writeLauncherSettings(root, [emptySearchRoot]);

			owner = spawnLauncher(
				launcherEnvironment(root, environment, llmServer, settingsPath, {
					PI_SESSION_ID: "targeted-owner",
				}),
				targetedArguments(target),
			);
			await waitForCondition(
				() => llmServer.events.some(({ type }) => type === "request_opened"),
				"targeted owner did not reach the LLM barrier",
			);
			const ownerRow = await readReconcilerRowEventually(
				prepared.dbPath,
				(row) => row.executionState === "START_AUTHORIZED",
			);
			assert.strictEqual(ownerRow.ownerInvocationMode, "targeted");

			waiter = spawnLauncher(
				launcherEnvironment(root, environment, llmServer, settingsPath, {
					PI_SESSION_ID: "global-waiter",
				}),
			);
			await observeStableWait(waiter, prepared.dbPath, {
				executionToken: ownerRow.executionToken,
				ownerToken: ownerRow.ownerToken,
				requestedGeneration: ownerRow.requestedGeneration,
				runningGeneration: ownerRow.runningGeneration,
			});
			const events = await readExecutionEvents(prepared.executionEventsPath);
			assert.deepStrictEqual(
				[...registeredExecutionTokens(events)],
				[ownerRow.executionToken],
			);
			assert.strictEqual(llmServer.overlapDetected(), false);
			assert.strictEqual(llmServer.maximumActiveExecutions(), 1);

			llmServer.release();
			assert.strictEqual(await waitForClose(owner.child), 0, owner.stderr());
			assert.strictEqual(await waitForClose(waiter.child), 0, waiter.stderr());

			const finalRow = readReconcilerRow(prepared.dbPath);
			assert.strictEqual(finalRow.requestedGeneration, 2);
			assert.strictEqual(finalRow.completedGeneration, 2);
			assert.strictEqual(finalRow.runningGeneration, null);
			assert.strictEqual(finalRow.ownerToken, null);
			assert.strictEqual(finalRow.ownerInvocationMode, null);
			assert.strictEqual(finalRow.executionToken, null);

			const targetHead = runGit(
				target.taskPath,
				["rev-parse", "HEAD"],
				environment,
			);
			assert.notStrictEqual(targetHead, target.baseline);
			assert.strictEqual(
				runGit(
					target.bareRemotePath,
					["rev-parse", target.pushRef],
					environment,
				),
				targetHead,
			);
		} finally {
			for (const record of [owner, waiter]) {
				if (
					record !== null &&
					record.child.exitCode === null &&
					record.child.signalCode === null
				) {
					record.child.kill("SIGKILL");
				}
			}
			await llmServer.close();
		}
	});
});

test("W4 | a targeted request waits for targeted owner A and runs B's exact scope", async () => {
	await withTemporaryDirectory(async (root) => {
		const llmServer = await startLlmOverlapServer();
		let owner = null;
		let waiter = null;
		try {
			const environment = isolatedEnvironment(root);
			const prepared = await prepareLauncherRoot(root, environment);
			const targetA = await createTargetFixture(root, environment, "a");
			const targetB = await createTargetFixture(root, environment, "b");
			const emptySearchRoot = path.join(root, "empty search");
			await mkdir(emptySearchRoot, { recursive: true });
			const settingsPath = await writeLauncherSettings(root, [emptySearchRoot]);

			owner = spawnLauncher(
				launcherEnvironment(root, environment, llmServer, settingsPath, {
					PI_SESSION_ID: "targeted-owner-a",
				}),
				targetedArguments(targetA),
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
			const ownerRequest = llmServer.events.find(
				(event) =>
					event.type === "request_opened" &&
					(event.payload?.files ?? []).includes("a-task.ts"),
			);
			const ownerRow = await readReconcilerRowEventually(
				prepared.dbPath,
				(row) => row.executionState === "START_AUTHORIZED",
			);
			assert.strictEqual(ownerRow.ownerInvocationMode, "targeted");
			assert.strictEqual(ownerRow.executionToken, ownerRequest.token);

			waiter = spawnLauncher(
				launcherEnvironment(root, environment, llmServer, settingsPath, {
					PI_SESSION_ID: "targeted-waiter-b",
				}),
				targetedArguments(targetB),
			);
			await observeStableWait(waiter, prepared.dbPath, {
				executionToken: ownerRow.executionToken,
				ownerToken: ownerRow.ownerToken,
				requestedGeneration: ownerRow.requestedGeneration,
				runningGeneration: ownerRow.runningGeneration,
			});
			const events = await readExecutionEvents(prepared.executionEventsPath);
			assert.deepStrictEqual(
				[...registeredExecutionTokens(events)],
				[ownerRow.executionToken],
			);

			llmServer.release();
			assert.strictEqual(await waitForClose(owner.child), 0, owner.stderr());
			assert.strictEqual(await waitForClose(waiter.child), 0, waiter.stderr());

			const finalRow = readReconcilerRow(prepared.dbPath);
			assert.strictEqual(finalRow.requestedGeneration, 2);
			assert.strictEqual(finalRow.completedGeneration, 2);
			assert.strictEqual(finalRow.ownerToken, null);
			assert.strictEqual(finalRow.ownerInvocationMode, null);

			const headA = runGit(
				targetA.taskPath,
				["rev-parse", "HEAD"],
				environment,
			);
			const headB = runGit(
				targetB.taskPath,
				["rev-parse", "HEAD"],
				environment,
			);
			assert.notStrictEqual(headA, targetA.baseline);
			assert.notStrictEqual(headB, targetB.baseline);
			assert.notStrictEqual(headB, headA);
			assert.strictEqual(
				runGit(
					targetA.bareRemotePath,
					["rev-parse", targetA.pushRef],
					environment,
				),
				headA,
			);
			assert.strictEqual(
				runGit(
					targetB.bareRemotePath,
					["rev-parse", targetB.pushRef],
					environment,
				),
				headB,
			);
			assert.strictEqual(
				llmServer.events.some(
					(event) =>
						event.type === "request_opened" &&
						(event.payload?.files ?? []).includes("b-task.ts"),
				),
				true,
			);
		} finally {
			for (const record of [owner, waiter]) {
				if (
					record !== null &&
					record.child.exitCode === null &&
					record.child.signalCode === null
				) {
					record.child.kill("SIGKILL");
				}
			}
			await llmServer.close();
		}
	});
});

test("W5 | a waiting targeted request terminated by SIGTERM leaves no durable request", async () => {
	await withTemporaryDirectory(async (root) => {
		const llmServer = await startLlmOverlapServer();
		let owner = null;
		let waiter = null;
		try {
			const environment = isolatedEnvironment(root);
			const prepared = await prepareLauncherRoot(root, environment);
			const globalRoot = path.join(root, "global search");
			const globalRepository = path.join(globalRoot, "repository");
			await createRepoWithBareRemote(
				globalRepository,
				path.join(root, "global.git"),
				environment,
			);
			await writeFile(
				path.join(globalRepository, "global.ts"),
				"export const globalWork = true;\n",
			);
			runGit(globalRepository, ["add", "global.ts"], environment);
			const target = await createTargetFixture(root, environment, "b");
			const settingsPath = await writeLauncherSettings(root, [globalRoot]);

			owner = spawnLauncher(
				launcherEnvironment(root, environment, llmServer, settingsPath, {
					PI_SESSION_ID: "global-owner",
				}),
			);
			await waitForCondition(
				() => llmServer.events.some(({ type }) => type === "request_opened"),
				"global owner did not reach the LLM barrier",
			);
			const ownerRow = await readReconcilerRowEventually(
				prepared.dbPath,
				(row) => row.executionState === "START_AUTHORIZED",
			);

			waiter = spawnLauncher(
				launcherEnvironment(root, environment, llmServer, settingsPath, {
					PI_SESSION_ID: "cancelled-targeted-waiter",
				}),
				targetedArguments(target),
			);
			await observeStableWait(waiter, prepared.dbPath, {
				executionToken: ownerRow.executionToken,
				ownerToken: ownerRow.ownerToken,
				requestedGeneration: ownerRow.requestedGeneration,
				runningGeneration: ownerRow.runningGeneration,
			});

			const waiterClosed = waitForCloseOutcome(waiter.child);
			waiter.child.kill("SIGTERM");
			const outcome = await waiterClosed;
			assert.strictEqual(outcome.signal, "SIGTERM");
			assert.strictEqual(outcome.code, null);

			const rowAfterSignal = readReconcilerRow(prepared.dbPath);
			assert.strictEqual(rowAfterSignal.requestedGeneration, 1);
			assert.strictEqual(rowAfterSignal.completedGeneration, 0);
			assert.strictEqual(rowAfterSignal.runningGeneration, 1);
			assert.strictEqual(rowAfterSignal.ownerToken, ownerRow.ownerToken);
			assert.strictEqual(rowAfterSignal.ownerInvocationMode, "global");
			assert.strictEqual(
				rowAfterSignal.executionToken,
				ownerRow.executionToken,
			);

			assert.strictEqual(
				runGit(target.taskPath, ["rev-parse", "HEAD"], environment),
				target.baseline,
			);
			assert.strictEqual(
				runGit(
					target.bareRemotePath,
					["rev-parse", target.pushRef],
					environment,
				),
				target.baseline,
			);
			const events = await readExecutionEvents(prepared.executionEventsPath);
			assert.deepStrictEqual(
				[...registeredExecutionTokens(events)],
				[ownerRow.executionToken],
			);

			llmServer.release();
			assert.strictEqual(await waitForClose(owner.child), 0, owner.stderr());
		} finally {
			for (const record of [owner, waiter]) {
				if (
					record !== null &&
					record.child.exitCode === null &&
					record.child.signalCode === null
				) {
					record.child.kill("SIGKILL");
				}
			}
			await llmServer.close();
		}
	});
});

test("W6 | a moved destination settles targeted failure without claiming success", async () => {
	await withTemporaryDirectory(async (root) => {
		const llmServer = await startLlmOverlapServer();
		let launcher = null;
		try {
			const environment = isolatedEnvironment(root);
			const prepared = await prepareLauncherRoot(root, environment);
			const target = await createTargetFixture(root, environment, "stale");
			const emptySearchRoot = path.join(root, "empty search");
			await mkdir(emptySearchRoot, { recursive: true });
			const settingsPath = await writeLauncherSettings(root, [emptySearchRoot]);

			launcher = spawnLauncher(
				launcherEnvironment(root, environment, llmServer, settingsPath, {
					PI_SESSION_ID: "stale-destination",
				}),
				targetedArguments(target),
			);
			await waitForCondition(
				() => llmServer.events.some(({ type }) => type === "request_opened"),
				"targeted pass did not reach the LLM barrier",
			);
			const advanced = await advanceBareRemote(root, target, environment);
			assert.notStrictEqual(advanced, target.baseline);

			llmServer.release();
			const exitCode = await waitForClose(launcher.child);
			assert.notStrictEqual(
				exitCode,
				0,
				`expected a terminal targeted failure, stdout=${launcher.stdout()} stderr=${launcher.stderr()}`,
			);

			const row = readReconcilerRow(prepared.dbPath);
			assert.strictEqual(row.requestedGeneration, 1);
			assert.strictEqual(row.completedGeneration, 1);
			assert.strictEqual(row.runningGeneration, null);
			assert.strictEqual(row.ownerToken, null);
			assert.strictEqual(row.ownerInvocationMode, null);
			assert.strictEqual(row.executionToken, null);
			assert.strictEqual(row.executionState, null);
			assert.strictEqual(
				runGit(
					target.bareRemotePath,
					["rev-parse", target.pushRef],
					environment,
				),
				advanced,
			);
		} finally {
			if (
				launcher !== null &&
				launcher.child.exitCode === null &&
				launcher.child.signalCode === null
			) {
				launcher.child.kill("SIGKILL");
			}
			await llmServer.close();
		}
	});
});

test("W7 | historical global debt converges before a targeted request is admitted", async () => {
	await withTemporaryDirectory(async (root) => {
		const llmServer = await startLlmOverlapServer();
		let launcher = null;
		try {
			const environment = isolatedEnvironment(root);
			const prepared = await prepareLauncherRoot(root, environment);
			const target = await createTargetFixture(root, environment, "ordered");
			const emptySearchRoot = path.join(root, "empty search");
			await mkdir(emptySearchRoot, { recursive: true });
			const settingsPath = await writeLauncherSettings(root, [emptySearchRoot]);

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
			const initialized = reconcilerDb.openReconcilerDb(prepared.dbPath);
			initialized.close();
			const raw = new DatabaseSync(prepared.dbPath);
			try {
				raw
					.prepare(
						"UPDATE reconciler_state SET requested_generation = 5, completed_generation = 3 WHERE singleton_id = 1",
					)
					.run();
			} finally {
				raw.close();
			}

			launcher = spawnLauncher(
				launcherEnvironment(root, environment, llmServer, settingsPath, {
					PI_SESSION_ID: "ordered-targeted-caller",
				}),
				targetedArguments(target),
			);
			await waitForCondition(
				() => llmServer.events.some(({ type }) => type === "request_opened"),
				"targeted pass never reached the LLM barrier",
			);
			const targetedRequest = llmServer.events.find(
				({ type }) => type === "request_opened",
			);
			const targetedRow = await readReconcilerRowEventually(
				prepared.dbPath,
				(row) =>
					row.executionToken === targetedRequest.token &&
					row.executionState === "START_AUTHORIZED",
			);
			assert.strictEqual(targetedRow.requestedGeneration, 7);
			assert.strictEqual(targetedRow.completedGeneration, 6);
			assert.strictEqual(targetedRow.runningGeneration, 7);
			assert.strictEqual(targetedRow.ownerInvocationMode, "targeted");
			assert.strictEqual(
				runGit(target.taskPath, ["rev-parse", "HEAD"], environment),
				target.baseline,
			);

			const events = await readExecutionEvents(prepared.executionEventsPath);
			const exitedTokens = new Set(
				events
					.filter(({ type }) => type === "supervisor_exited")
					.map(({ executionToken }) => executionToken),
			);
			const recoveryToken = events
				.filter(({ type }) => type === "supervisor_started")
				.map(({ executionToken }) => executionToken)
				.find((token) => exitedTokens.has(token));
			assert.ok(recoveryToken, "global recovery execution never exited");
			assert.notStrictEqual(recoveryToken, targetedRequest.token);
			const recoveryExitIndex = events.findIndex(
				(event) =>
					event.type === "supervisor_exited" &&
					event.executionToken === recoveryToken,
			);
			const targetedStartIndex = events.findIndex(
				(event) =>
					event.type === "supervisor_started" &&
					event.executionToken === targetedRequest.token,
			);
			assert.ok(
				recoveryExitIndex >= 0 && recoveryExitIndex < targetedStartIndex,
			);

			llmServer.release();
			assert.strictEqual(
				await waitForClose(launcher.child),
				0,
				launcher.stderr(),
			);

			const finalRow = readReconcilerRow(prepared.dbPath);
			assert.strictEqual(finalRow.requestedGeneration, 7);
			assert.strictEqual(finalRow.completedGeneration, 7);
			assert.strictEqual(finalRow.runningGeneration, null);
			assert.strictEqual(finalRow.ownerToken, null);
			assert.strictEqual(finalRow.ownerInvocationMode, null);
			assert.strictEqual(finalRow.executionToken, null);
			const targetHead = runGit(
				target.taskPath,
				["rev-parse", "HEAD"],
				environment,
			);
			assert.notStrictEqual(targetHead, target.baseline);
			assert.strictEqual(
				runGit(
					target.bareRemotePath,
					["rev-parse", target.pushRef],
					environment,
				),
				targetHead,
			);
		} finally {
			if (
				launcher !== null &&
				launcher.child.exitCode === null &&
				launcher.child.signalCode === null
			) {
				launcher.child.kill("SIGKILL");
			}
			await llmServer.close();
		}
	});
});
