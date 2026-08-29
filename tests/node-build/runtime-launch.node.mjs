import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const compiledRuntimeLaunchPath = path.join(
	compiledSkillDirectory,
	"src",
	"utils",
	"runtime-launch.js",
);
const sourceRuntimeLaunchPath = path.join(
	skillDirectory,
	"src",
	"utils",
	"runtime-launch.ts",
);
const compiledBridgePath = path.join(
	compiledSkillDirectory,
	"src",
	"entrypoints",
	"turnlock-to-llm-bridge.js",
);
const compiledLockManagerPath = path.join(
	compiledSkillDirectory,
	"src",
	"utils",
	"lock-manager.js",
);
const runtimeLaunch = await import(
	pathToFileURL(compiledRuntimeLaunchPath).href
);
const sourceRuntimeLaunch = await import(
	pathToFileURL(sourceRuntimeLaunchPath).href
);
const { executeResumeCommand } = await import(
	pathToFileURL(compiledBridgePath).href
);
const compiledLockManager = await import(
	pathToFileURL(compiledLockManagerPath).href
);

async function withTemporaryDirectory(callback) {
	const directory = await mkdtemp(path.join(tmpdir(), "runtime-launch-é-"));
	try {
		await callback(directory);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

function orderContext(orderId, overrides = {}) {
	return {
		callerName: "Node Test Agent",
		isQueuedOrder: false,
		orderId,
		originAgent: "test",
		...overrides,
	};
}

test("preserves historical Bun source resume and dequeue launches", () => {
	const sourceOrchestratorUrl = pathToFileURL(
		path.join(skillDirectory, "src", "entrypoints", "turnlock-orchestrator.ts"),
	).href;
	assert.equal(
		sourceRuntimeLaunch.buildResumeCommand(
			"run-historical",
			sourceOrchestratorUrl,
			"/unused/node",
		),
		"bun run src/entrypoints/turnlock-orchestrator.ts --run-id run-historical --resume",
	);

	const sourceLockManagerUrl = pathToFileURL(
		path.join(skillDirectory, "src", "utils", "lock-manager.ts"),
	).href;
	assert.deepEqual(
		sourceRuntimeLaunch.buildQueuedOrderLaunch(
			sourceLockManagerUrl,
			"/unused/node",
		),
		{
			args: ["run", "start"],
			command: "bun",
			cwd: skillDirectory,
		},
	);
});

test("builds compiled resume and dequeue launches as shell-free Node arguments", async () => {
	await withTemporaryDirectory(async (directory) => {
		const compiledRoot = path.join(directory, "compiled skill 漢字");
		const orchestratorPath = path.join(
			compiledRoot,
			"src",
			"entrypoints",
			"turnlock-orchestrator.js",
		);
		const lockManagerPath = path.join(
			compiledRoot,
			"src",
			"utils",
			"lock-manager.js",
		);
		const nodePath = path.join(directory, "Node Runtime", "node");
		const runId = "run with spaces; $(printf unsafe) — é";
		const orchestratorUrl = pathToFileURL(orchestratorPath).href;
		const resumeLaunch = runtimeLaunch.buildResumeLaunch(
			runId,
			orchestratorUrl,
			nodePath,
		);
		assert.deepEqual(resumeLaunch, {
			args: [orchestratorPath, "--run-id", runId, "--resume"],
			command: nodePath,
			cwd: compiledRoot,
		});
		assert.equal(
			runtimeLaunch.buildResumeCommand(runId, orchestratorUrl, nodePath),
			[nodePath, ...resumeLaunch.args].map(JSON.stringify).join(" "),
		);

		assert.deepEqual(
			runtimeLaunch.buildQueuedOrderLaunch(
				pathToFileURL(lockManagerPath).href,
				nodePath,
			),
			{
				args: [
					path.join(compiledRoot, "src", "entrypoints", "node-supervisor.js"),
				],
				command: nodePath,
				cwd: compiledRoot,
			},
		);
	});
});

test("executes only the exact compiled resume command without a shell", async () => {
	await withTemporaryDirectory(async (directory) => {
		const entrypointDirectory = path.join(
			directory,
			"compiled bridge with spaces",
			"src",
			"entrypoints",
		);
		await mkdir(entrypointDirectory, { recursive: true });
		const orchestratorPath = path.join(
			entrypointDirectory,
			"turnlock-orchestrator.js",
		);
		const bridgePath = path.join(
			entrypointDirectory,
			"turnlock-to-llm-bridge.js",
		);
		await writeFile(
			orchestratorPath,
			"process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
		);
		await writeFile(bridgePath, "");
		const runId = "run; $(printf must-not-execute) — 漢字";
		const resumeCommand = runtimeLaunch.buildResumeCommand(
			runId,
			pathToFileURL(orchestratorPath).href,
			process.execPath,
		);
		assert.deepEqual(
			JSON.parse(
				await executeResumeCommand(
					resumeCommand,
					runId,
					pathToFileURL(bridgePath).href,
				),
			),
			["--run-id", runId, "--resume"],
		);
		await assert.rejects(
			executeResumeCommand(
				`${resumeCommand} extra-command`,
				runId,
				pathToFileURL(bridgePath).href,
			),
			/Resume command is incompatible with the compiled Node runtime/,
		);

		await writeFile(
			orchestratorPath,
			'process.stdout.write("partial-protocol"); process.exitCode = 7;\n',
		);
		await assert.rejects(
			executeResumeCommand(
				resumeCommand,
				runId,
				pathToFileURL(bridgePath).href,
			),
			(error) => {
				assert.match(error.message, /exit code 7/);
				assert.equal(error.stdout, "partial-protocol");
				return true;
			},
		);
	});
});

test("dequeues through process.execPath and the compiled supervisor", async () => {
	await withTemporaryDirectory(async (directory) => {
		const previousEnvironment = {
			DISABLE_REAL_SPAWN: process.env.DISABLE_REAL_SPAWN,
			ORDER_STATE_DIR: process.env.ORDER_STATE_DIR,
			PI_SKILL_STATS_DIR: process.env.PI_SKILL_STATS_DIR,
			PI_SKILL_STATS_MODE: process.env.PI_SKILL_STATS_MODE,
		};
		process.env.ORDER_STATE_DIR = path.join(directory, "orders");
		process.env.PI_SKILL_STATS_DIR = path.join(directory, "stats");
		process.env.PI_SKILL_STATS_MODE = "test";
		delete process.env.DISABLE_REAL_SPAWN;
		let spawnCall;
		try {
			compiledLockManager.checkAndAcquireLock(
				"run-active",
				orderContext("order-active"),
			);
			compiledLockManager.checkAndAcquireLock(
				"run-queued",
				orderContext("order-queued", { originSessionId: "session-é" }),
			);
			const result = compiledLockManager.releaseLockAndTriggerNext(
				"run-active",
				(command, args, options) => {
					spawnCall = { args, command, options };
					return {
						output: [],
						pid: 1,
						signal: null,
						status: 0,
						stderr: null,
						stdout: null,
					};
				},
			);
			assert.equal(result.kind, "released");
			assert.equal(result.triggeredOrder?.orderId, "order-queued");
			assert.equal(spawnCall.command, process.execPath);
			assert.deepEqual(spawnCall.args, [
				path.join(
					compiledSkillDirectory,
					"src",
					"entrypoints",
					"node-supervisor.js",
				),
			]);
			assert.equal(spawnCall.options.cwd, compiledSkillDirectory);
			assert.equal(spawnCall.options.shell, false);
			assert.equal(spawnCall.options.stdio, "inherit");
			assert.equal(spawnCall.options.env.GCP_ORDER_ID, "order-queued");
			assert.equal(
				spawnCall.options.env.GCP_ORDER_ORIGIN_SESSION_ID,
				"session-é",
			);
			assert.doesNotMatch(
				`${spawnCall.command} ${spawnCall.args.join(" ")}`,
				/\b(?:bun|pnpm)\b/,
			);
		} finally {
			compiledLockManager.stopHeartbeat();
			for (const [key, value] of Object.entries(previousEnvironment)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
