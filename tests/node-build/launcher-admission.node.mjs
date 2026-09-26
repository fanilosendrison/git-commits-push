import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
	startLlmOverlapServer,
	waitForCondition,
} from "./fixtures/execution-lifetime-helpers.mjs";
import {
	compiledSkillDirectory,
	createOrdinaryFixture,
	createTargetFixture,
	isolatedEnvironment,
	launcherEnvironment,
	mockFetchPreloadPath,
	nodeLauncherPath,
	observeStableWait,
	prepareLauncherRoot,
	readExecutionEvents,
	readReconcilerRow,
	readReconcilerRowEventually,
	registeredExecutionTokens,
	runGit,
	skillDirectory,
	spawnLauncher,
	targetedArguments,
	waitForClose,
	waitForFile,
	withTemporaryDirectory,
	writeLauncherSettings,
} from "./fixtures/launcher-admission-helpers.mjs";
import { createRepoWithBareRemote } from "./fixtures/reconciler-e2e-helpers.mjs";

test("I0 | SIGTERM during build settles the exact generation without a build result", async () => {
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
		const invocationRepository = path.join(root, "invocation repository");
		await createRepoWithBareRemote(
			invocationRepository,
			path.join(root, "invocation.git"),
			environment,
		);
		const launcher = spawn(process.execPath, [nodeLauncherPath], {
			cwd: invocationRepository,
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
			// The exact request settles its generation on release; no execution ever
			// registered, and the settled generation creates no replay obligation.
			assert.strictEqual(state.completedGeneration, 1);
			assert.strictEqual(state.ownerToken, null);
		} finally {
			verification.close();
		}
	});
});

test("I1 | ordinary launcher requests serialize without coalescing", async () => {
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
		const dbPath = path.join(orderStateDirectory, "reconciler.sqlite");

		// The owner builds dist from its exact worktree and then blocks at the
		// LLM barrier.
		const owner = spawnLauncher(baseEnvironment, [], repositoryPath);
		const ownerClosed = waitForClose(owner.child);
		await waitForFile(firstCallMarker, 240_000);
		const ownerRow = await readReconcilerRowEventually(
			dbPath,
			(row) => row.executionState === "START_AUTHORIZED",
		);

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

		// A concurrent ordinary invocation from the same worktree must WAIT
		// without coalescing, mutating the coordinator, or building.
		const waiter = spawnLauncher(
			{ ...baseEnvironment, PI_SESSION_ID: "admission-waiter" },
			[],
			repositoryPath,
		);
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		assert.strictEqual(waiter.child.exitCode, null, "waiter exited early");
		assert.strictEqual(
			waiter.child.signalCode,
			null,
			"waiter was signalled early",
		);
		assert.deepStrictEqual(readReconcilerRow(dbPath), ownerRow);
		assert.ok(
			existsSync(sentinelPath),
			"a waiting caller must never reach the build step",
		);
		assert.equal(statSync(supervisorArtifact).mtimeMs, artifactMtime);

		// Release the owner; it finishes its single pass and converges.
		writeFileSync(releaseFile, "");
		assert.strictEqual(await ownerClosed, 0, owner.stderr());
		assert.strictEqual(await waitForClose(waiter.child), 0, waiter.stderr());

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

		// The owner ran one exact pass and the waiter later ran its own exact
		// second pass; neither coalesced into the other.
		const runsDirectory = path.join(turnlockRunRoot, "git-commits-push-tl");
		const runEntries = (
			await readdir(runsDirectory, { withFileTypes: true })
		).filter((entry) => entry.isDirectory());
		assert.equal(runEntries.length, 2);

		const stateEntries = await readdir(orderStateDirectory);
		assert.equal(
			stateEntries.some(
				(name) => name === "running.lock" || name.startsWith("order-"),
			),
			false,
		);
		// The second exact pass observes the clean repository and needs no LLM
		// request; only the first pass has work to plan.
		const requestLines = (await readFile(requestLogPath, "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean);
		assert.equal(requestLines.length, 1);
	});
});

test("W2 | an ordinary worktree owner serializes a targeted waiter", async () => {
	await withTemporaryDirectory(async (root) => {
		const llmServer = await startLlmOverlapServer();
		let owner = null;
		let waiter = null;
		try {
			const environment = isolatedEnvironment(root);
			const prepared = await prepareLauncherRoot(root, environment);
			const ordinary = await createOrdinaryFixture(
				root,
				environment,
				"ordinary-owner",
			);
			await writeFile(
				path.join(ordinary.repositoryPath, "ordinary.ts"),
				"export const ordinaryWork = true;\n",
			);
			runGit(ordinary.repositoryPath, ["add", "ordinary.ts"], environment);
			const ordinaryBaseline = runGit(
				ordinary.repositoryPath,
				["rev-parse", "HEAD"],
				environment,
			);
			const target = await createTargetFixture(root, environment, "b");
			const settingsPath = await writeLauncherSettings(root, [
				path.dirname(ordinary.repositoryPath),
			]);

			owner = spawnLauncher(
				launcherEnvironment(root, environment, llmServer, settingsPath, {
					PI_SESSION_ID: "ordinary-owner",
				}),
				[],
				ordinary.repositoryPath,
			);
			await waitForCondition(
				() => llmServer.events.some(({ type }) => type === "request_opened"),
				"ordinary owner did not reach the LLM barrier",
			);
			const ownerRow = await readReconcilerRowEventually(
				prepared.dbPath,
				(row) => row.executionState === "START_AUTHORIZED",
			);
			assert.strictEqual(ownerRow.ownerInvocationMode, "targeted");

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

			const ordinaryHead = runGit(
				ordinary.repositoryPath,
				["rev-parse", "HEAD"],
				environment,
			);
			assert.notStrictEqual(ordinaryHead, ordinaryBaseline);
			assert.strictEqual(
				runGit(ordinary.repositoryPath, ["status", "--porcelain"], environment),
				"",
			);
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

test("W3 | an ordinary worktree request waits for a targeted owner", async () => {
	await withTemporaryDirectory(async (root) => {
		const llmServer = await startLlmOverlapServer();
		let owner = null;
		let waiter = null;
		try {
			const environment = isolatedEnvironment(root);
			const prepared = await prepareLauncherRoot(root, environment);
			const target = await createTargetFixture(root, environment, "a");
			const ordinary = await createOrdinaryFixture(
				root,
				environment,
				"ordinary-waiter",
			);
			await writeFile(
				path.join(ordinary.repositoryPath, "waiter.ts"),
				"export const waiterWork = true;\n",
			);
			runGit(ordinary.repositoryPath, ["add", "waiter.ts"], environment);
			const ordinaryBaseline = runGit(
				ordinary.repositoryPath,
				["rev-parse", "HEAD"],
				environment,
			);
			const settingsPath = await writeLauncherSettings(root, [
				path.dirname(ordinary.repositoryPath),
			]);

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
					PI_SESSION_ID: "ordinary-waiter",
				}),
				[],
				ordinary.repositoryPath,
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
			const ordinaryHead = runGit(
				ordinary.repositoryPath,
				["rev-parse", "HEAD"],
				environment,
			);
			assert.notStrictEqual(ordinaryHead, ordinaryBaseline);
			assert.strictEqual(
				runGit(ordinary.repositoryPath, ["status", "--porcelain"], environment),
				"",
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
