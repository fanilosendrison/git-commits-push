import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { waitForCondition } from "./fixtures/execution-lifetime-helpers.mjs";
import {
	isolatedEnvironment,
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
const executionControllerPath = path.join(
	compiledSkillDirectory,
	"src/entrypoints/execution-controller.js",
);
const pipelineStagePath = path.join(
	testDirectory,
	"fixtures/pipeline-stage.mjs",
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

function waitForControllerMessage(controller, expectedType, token) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error(`controller did not send ${expectedType}`));
		}, 30_000);
		const onMessage = (message) => {
			if (message?.type !== expectedType || message.token !== token) return;
			cleanup();
			resolve(message);
		};
		const onClose = () => {
			cleanup();
			reject(new Error(`controller exited before ${expectedType}`));
		};
		const cleanup = () => {
			clearTimeout(timeout);
			controller.removeListener("message", onMessage);
			controller.removeListener("close", onClose);
		};
		controller.on("message", onMessage);
		controller.once("close", onClose);
	});
}

async function createFixture(root) {
	const environment = isolatedEnvironment(root);
	await mkdir(environment.HOME, { recursive: true });
	await mkdir(environment.XDG_CONFIG_HOME, { recursive: true });
	const orderStateDirectory = path.join(root, "reconciler state");
	const eventsPath = path.join(root, "execution-events.jsonl");
	const settingsPath = path.join(root, "settings.json");
	for (const directory of [
		orderStateDirectory,
		path.join(root, "turnlock runs"),
		path.join(root, "telemetry"),
		path.join(root, "scanner telemetry"),
	]) {
		await mkdir(directory, { recursive: true });
	}
	await writeFile(eventsPath, "");
	await writeFile(
		settingsPath,
		JSON.stringify({
			autoPush: false,
			model: "gpt-5.4-mini",
			provider: "openai",
			searchPaths: [path.join(root, "empty search root")],
			skipTests: true,
			systemPromptPath: path.join(compiledSkillDirectory, "system-prompt.md"),
			temperature: 0,
		}),
	);
	return {
		eventsPath,
		orderStateDirectory,
		environment: {
			...environment,
			GCP_TEST_EXECUTION_EVENTS_PATH: eventsPath,
			NODE_ENV: "test",
			OPENAI_API_KEY: "sk-test",
			ORDER_STATE_DIR: orderStateDirectory,
			PI_SESSION_ID: "startup-race",
			PI_SKILL_STATS_DIR: path.join(root, "telemetry"),
			SECRET_SCANNER_STATS_DIR: path.join(root, "scanner telemetry"),
			TURNLOCK_RUN_DIR_ROOT: path.join(root, "turnlock runs"),
			TURNLOCK_SKILL_SETTINGS_PATH: settingsPath,
		},
	};
}

async function importReconcilerDb() {
	return await import(
		pathToFileURL(
			path.join(
				compiledSkillDirectory,
				"src/modules/reconciliation/reconciler-db.js",
			),
		).href
	);
}

async function runRecovery(environment) {
	const child = spawn(process.execPath, [publicLauncherPath], {
		cwd: skillDirectory,
		env: environment,
		shell: false,
		stdio: "ignore",
	});
	assert.strictEqual(await waitForClose(child), 0);
}

async function assertConverged(reconcilerDb, stateDirectory) {
	const db = reconcilerDb.openReconcilerDb(
		reconcilerDb.resolveReconcilerDbPath(stateDirectory),
	);
	try {
		const state = reconcilerDb.readReconcilerState(db);
		assert.strictEqual(state.requestedGeneration, 2);
		assert.strictEqual(state.completedGeneration, 2);
		assert.strictEqual(state.ownerToken, null);
		assert.strictEqual(state.activeExecution, null);
	} finally {
		db.close();
	}
}

test("EXEC-INV-8 | IPC loss immediately after supervisor spawn kills the full boundary", {
	skip: process.platform !== "darwin" && process.platform !== "linux",
}, async () => {
	await withTemporaryDirectory(async (root) => {
		const eventsPath = path.join(root, "execution-events.jsonl");
		const startedMessageBarrier = path.join(root, "release-started-send");
		const disconnectBarrier = path.join(root, "never-release-disconnect");
		await writeFile(eventsPath, "");
		const token = "immediate-ipc-disconnect";
		const controller = spawn(
			process.execPath,
			[executionControllerPath, pipelineStagePath, "signal-producer"],
			{
				cwd: compiledSkillDirectory,
				detached: true,
				env: {
					...process.env,
					GCP_TEST_EXECUTION_DISCONNECT_BARRIER: disconnectBarrier,
					GCP_TEST_EXECUTION_EVENTS_PATH: eventsPath,
					GCP_TEST_EXECUTION_STARTED_MESSAGE_BARRIER: startedMessageBarrier,
					NODE_ENV: "test",
					PIPELINE_SIGNAL_LOG: path.join(root, "signals.log"),
				},
				shell: false,
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			},
		);
		try {
			await new Promise((resolve, reject) => {
				controller.once("spawn", resolve);
				controller.once("error", reject);
			});
			const readyPromise = waitForControllerMessage(controller, "READY", token);
			controller.send({ type: "PREPARE", version: 1, token });
			const ready = await readyPromise;
			assert.strictEqual(ready.groupId, controller.pid);
			controller.send({ type: "START", version: 1, token });
			await waitForCondition(
				() =>
					readEvents(eventsPath).then((events) =>
						events.some(
							(event) =>
								event.type === "supervisor_started" &&
								event.executionToken === token,
						),
					),
				"controller did not spawn the supervisor",
			);
			assert.strictEqual(processGroupExists(ready.groupId), true);
			controller.disconnect();
			await writeFile(startedMessageBarrier, "release\n");
			await waitForCondition(
				() => controller.exitCode !== null || controller.signalCode !== null,
				"controller did not exit after immediate IPC loss",
			);
			assert.strictEqual(processGroupExists(ready.groupId), false);
			const events = await readEvents(eventsPath);
			assert.strictEqual(
				events.some(
					(event) =>
						event.type === "boundary_termination_started" &&
						event.executionToken === token,
				),
				true,
			);
		} finally {
			if (controller.pid !== undefined && processGroupExists(controller.pid)) {
				process.kill(-controller.pid, "SIGKILL");
			}
		}
	});
});

for (const scenario of [
	{
		name: "EXEC-INV-2 | launcher death before registration never starts execution",
		barrierKey: "GCP_TEST_EXECUTION_READY_BARRIER",
		expectedState: null,
		eventType: "controller_ready",
	},
	{
		name: "EXEC-INV-2/3 | registered-before-START death is durably recovered",
		barrierKey: "GCP_TEST_EXECUTION_REGISTERED_BARRIER",
		expectedState: "REGISTERED",
		eventType: "launcher_execution_registered",
	},
	{
		name: "EXEC-INV-4/8 | death immediately after START cannot overlap recovery",
		barrierKey: "GCP_TEST_EXECUTION_START_BARRIER",
		expectedState: "START_AUTHORIZED",
		eventType: "controller_start_received",
	},
]) {
	test(scenario.name, {
		skip: process.platform !== "darwin" && process.platform !== "linux",
	}, async () => {
		await withTemporaryDirectory(async (root) => {
			const fixture = await createFixture(root);
			const blockedEnvironment = {
				...fixture.environment,
				[scenario.barrierKey]: path.join(root, "never-release"),
			};
			const owner = spawn(process.execPath, [publicLauncherPath], {
				cwd: skillDirectory,
				env: blockedEnvironment,
				shell: false,
				stdio: "ignore",
			});
			await waitForCondition(
				async () =>
					(await readEvents(fixture.eventsPath)).some(
						({ type }) => type === scenario.eventType,
					),
				`startup race did not reach ${scenario.eventType}`,
			);
			const events = await readEvents(fixture.eventsPath);
			const firstEvent = events.find(({ type }) => type === scenario.eventType);
			assert.ok(firstEvent);
			const controllerEvent = events.find(
				(event) =>
					event.type === "controller_ready" &&
					event.executionToken === firstEvent.executionToken,
			);
			assert.ok(controllerEvent);
			const reconcilerDb = await importReconcilerDb();
			const dbPath = reconcilerDb.resolveReconcilerDbPath(
				fixture.orderStateDirectory,
			);
			const during = reconcilerDb.openReconcilerDb(dbPath);
			try {
				assert.strictEqual(
					reconcilerDb.readReconcilerState(during).activeExecution?.state ??
						null,
					scenario.expectedState,
				);
			} finally {
				during.close();
			}

			const closed = waitForClose(owner);
			owner.kill("SIGKILL");
			await closed;
			await waitForCondition(
				() => !processGroupExists(controllerEvent.groupId),
				"prestart execution controller did not die with its IPC parent",
			);
			const afterDeathEvents = await readEvents(fixture.eventsPath);
			assert.strictEqual(
				afterDeathEvents.some(
					(event) =>
						event.executionToken === firstEvent.executionToken &&
						event.type === "supervisor_started",
				),
				false,
			);

			await runRecovery(fixture.environment);
			await assertConverged(reconcilerDb, fixture.orderStateDirectory);
		});
	});
}
