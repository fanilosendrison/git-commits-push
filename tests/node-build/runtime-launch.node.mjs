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
const runtimeLaunch = await import(
	pathToFileURL(compiledRuntimeLaunchPath).href
);
const sourceRuntimeLaunch = await import(
	pathToFileURL(sourceRuntimeLaunchPath).href
);
const { executeResumeCommand } = await import(
	pathToFileURL(compiledBridgePath).href
);

async function withTemporaryDirectory(callback) {
	const directory = await mkdtemp(path.join(tmpdir(), "runtime-launch-é-"));
	try {
		await callback(directory);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

test("builds Node source resume launches", () => {
	const sourceOrchestratorUrl = pathToFileURL(
		path.join(skillDirectory, "src", "entrypoints", "turnlock-orchestrator.ts"),
	).href;
	assert.equal(
		sourceRuntimeLaunch.buildResumeCommand(
			"run-historical",
			sourceOrchestratorUrl,
			"/unused/node",
		),
		'"/unused/node" "src/entrypoints/turnlock-orchestrator.ts" "--run-id" "run-historical" "--resume"',
	);
});

test("builds compiled resume launches as shell-free Node arguments", async () => {
	await withTemporaryDirectory(async (directory) => {
		const compiledRoot = path.join(directory, "compiled skill 漢字");
		const orchestratorPath = path.join(
			compiledRoot,
			"src",
			"entrypoints",
			"turnlock-orchestrator.js",
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
