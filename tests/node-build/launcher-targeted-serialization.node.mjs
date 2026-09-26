import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
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
	observeStableWait,
	prepareLauncherRoot,
	readExecutionEvents,
	readReconcilerRow,
	readReconcilerRowEventually,
	registeredExecutionTokens,
	runGit,
	spawnLauncher,
	targetedArguments,
	waitForClose,
	waitForCloseOutcome,
	withTemporaryDirectory,
	writeLauncherSettings,
} from "./fixtures/launcher-admission-helpers.mjs";

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
			assert.strictEqual(rowAfterSignal.ownerInvocationMode, "targeted");
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
			// The legacy global-debt recovery pass transports the launcher cwd, so
			// the launcher runs from its own attached ordinary fixture worktree.
			const ordinary = await createOrdinaryFixture(
				root,
				environment,
				"ordered-recovery",
			);
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
				ordinary.repositoryPath,
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
