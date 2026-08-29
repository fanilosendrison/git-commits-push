import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
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
const nodeLauncherPath = path.join(skillDirectory, "scripts", "start-node.mjs");
const mockFetchPreloadPath = path.join(
	testDirectory,
	"fixtures",
	"mock-openai-fetch.mjs",
);
const SYNTHETIC_API_KEY = `sk-${"N".repeat(48)}`;

async function withTemporaryDirectory(callback) {
	const directory = await mkdtemp(
		path.join(tmpdir(), "compiled-bare-remote-pipeline-é-"),
	);
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

async function readJsonLines(filePath) {
	return (await readFile(filePath, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function protocolActions(stdout) {
	return [...stdout.matchAll(/@@TURNLOCK@@\n([\s\S]*?)@@END@@/g)].map(
		(match) => {
			const actionLine = match[1]
				?.split("\n")
				.find((line) => line.startsWith("action: "));
			return actionLine?.slice("action: ".length) ?? "missing";
		},
	);
}

function nonProtocolBytes(stdout) {
	return stdout.replace(/@@TURNLOCK@@[\s\S]*?@@END@@/g, "").replace(/\s/g, "");
}

test("compiled supervisor commits and pushes through a local bare remote", async () => {
	await withTemporaryDirectory(async (root) => {
		const environment = isolatedEnvironment(root);
		await mkdir(environment.HOME, { recursive: true });
		await mkdir(environment.XDG_CONFIG_HOME, { recursive: true });

		const searchRoot = path.join(root, "search root 漢字");
		const repositoryPath = path.join(searchRoot, "repository with spaces é");
		const bareRemotePath = path.join(root, "bare remote 漢字.git");
		await mkdir(repositoryPath, { recursive: true });
		await mkdir(bareRemotePath, { recursive: true });
		runGit(bareRemotePath, ["init", "--bare", "--quiet"], environment);
		runGit(repositoryPath, ["init", "--quiet"], environment);
		runGit(
			repositoryPath,
			["config", "user.name", "Compiled Pipeline"],
			environment,
		);
		runGit(
			repositoryPath,
			["config", "user.email", "compiled-pipeline@example.invalid"],
			environment,
		);
		await writeFile(path.join(repositoryPath, "README.md"), "initial\n");
		runGit(repositoryPath, ["add", "README.md"], environment);
		runGit(
			repositoryPath,
			["commit", "--quiet", "--no-verify", "-m", "initial"],
			environment,
		);
		runGit(
			repositoryPath,
			["remote", "add", "origin", bareRemotePath],
			environment,
		);
		runGit(
			repositoryPath,
			["push", "--quiet", "--set-upstream", "origin", "HEAD"],
			environment,
		);
		await writeFile(
			path.join(repositoryPath, "pipeline.ts"),
			"export const compiledPipeline = true;\n",
		);
		runGit(repositoryPath, ["add", "pipeline.ts"], environment);

		const turnlockRunRoot = path.join(root, "turnlock runs é");
		const orderStateDirectory = path.join(root, "order state 漢字");
		const statsDirectory = path.join(root, "pipeline telemetry é");
		const scannerStatsDirectory = path.join(root, "scanner telemetry 漢字");
		const enforcerStatsDirectory = path.join(root, "enforcer telemetry é");
		const temporaryDirectory = path.join(root, "temporary files 漢字");
		const settingsPath = path.join(root, "settings with spaces.json");
		const requestLogPath = path.join(root, "mock LLM requests.jsonl");
		for (const directory of [
			turnlockRunRoot,
			orderStateDirectory,
			statsDirectory,
			scannerStatsDirectory,
			enforcerStatsDirectory,
			temporaryDirectory,
		]) {
			await mkdir(directory, { recursive: true });
		}
		await writeFile(
			settingsPath,
			JSON.stringify({
				agent: "git-commits-push",
				autoPush: true,
				model: "gpt-5.4-mini",
				provider: "openai",
				searchPaths: [searchRoot],
				skipTests: true,
				systemPromptPath: path.join(compiledSkillDirectory, "system-prompt.md"),
				temperature: 0,
			}),
		);

		const sentinelDirectory = path.join(root, "runtime sentinels");
		const sentinelLogPath = path.join(root, "runtime-sentinel.log");
		await mkdir(sentinelDirectory, { recursive: true });
		for (const executableName of ["bun", "pnpm"]) {
			const executablePath = path.join(sentinelDirectory, executableName);
			await writeFile(
				executablePath,
				`#!/bin/sh\nprintf '%s\\n' '${executableName}' >> "$RUNTIME_SENTINEL_LOG"\nexit 97\n`,
				{ mode: 0o755 },
			);
			await chmod(executablePath, 0o755);
		}

		const pipelineEnvironment = {
			...environment,
			DISABLE_REAL_SPAWN: "1",
			GIT_COMMITS_PUSH_ENFORCER_STATS_DIR: enforcerStatsDirectory,
			MOCK_LLM_REQUEST_LOG: requestLogPath,
			NODE_OPTIONS: `--import=${pathToFileURL(mockFetchPreloadPath).href}`,
			OPENAI_API_KEY: SYNTHETIC_API_KEY,
			ORDER_STATE_DIR: orderStateDirectory,
			PATH: `${sentinelDirectory}${path.delimiter}${environment.PATH ?? ""}`,
			PI_PARENT_MODEL: "compiled-parent-model",
			PI_SESSION_ID: "compiled-bare-remote-pipeline",
			PI_SKILL_STATS_DIR: statsDirectory,
			PI_SKILL_STATS_MODE: "",
			RUNTIME_SENTINEL_LOG: sentinelLogPath,
			SECRET_SCANNER_STATS_DIR: scannerStatsDirectory,
			TEMP: temporaryDirectory,
			TMP: temporaryDirectory,
			TMPDIR: temporaryDirectory,
			TURNLOCK_RUN_DIR_ROOT: turnlockRunRoot,
			TURNLOCK_SKILL_SETTINGS_PATH: settingsPath,
		};
		assert.match(
			runGit(repositoryPath, ["status", "--porcelain"], environment),
			/pipeline\.ts/,
		);
		const packageManifest = JSON.parse(
			await readFile(path.join(skillDirectory, "package.json"), "utf8"),
		);
		assert.equal(packageManifest.scripts?.start, "node scripts/start-node.mjs");
		const pipeline = spawnSync(process.execPath, [nodeLauncherPath], {
			cwd: skillDirectory,
			encoding: "utf8",
			env: pipelineEnvironment,
			maxBuffer: 50 * 1024 * 1024,
			shell: false,
			timeout: 90_000,
		});
		assert.equal(
			pipeline.status,
			0,
			`compiled pipeline failed: ${pipeline.stderr}\n${pipeline.stdout}`,
		);
		assert.equal(pipeline.signal, null);
		assert.deepEqual(
			protocolActions(pipeline.stdout),
			["DELEGATE", "DONE"],
			`stdout=${pipeline.stdout}\nstderr=${pipeline.stderr}`,
		);
		assert.equal(nonProtocolBytes(pipeline.stdout), "");
		assert.doesNotMatch(pipeline.stdout, /action: ERROR/);
		assert.match(pipeline.stderr, /Retry delegation detected/);
		assert.match(pipeline.stderr, /=== TURNLOCK EXECUTION REPORT ===/);
		for (const secret of [SYNTHETIC_API_KEY]) {
			assert.equal(pipeline.stdout.includes(secret), false);
			assert.equal(pipeline.stderr.includes(secret), false);
		}

		const branchName = runGit(
			repositoryPath,
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			environment,
		);
		assert.equal(
			runGit(repositoryPath, ["status", "--porcelain"], environment),
			"",
		);
		assert.match(
			runGit(repositoryPath, ["log", "-1", "--pretty=%s"], environment),
			/^feat: complete compiled bare remote pipeline$/,
		);
		assert.equal(
			runGit(repositoryPath, ["rev-parse", "HEAD"], environment),
			runGit(
				bareRemotePath,
				["rev-parse", `refs/heads/${branchName}`],
				environment,
			),
		);

		const runsDirectory = path.join(turnlockRunRoot, "git-commits-push-tl");
		const runEntries = (
			await readdir(runsDirectory, { withFileTypes: true })
		).filter((entry) => entry.isDirectory());
		assert.equal(runEntries.length, 1);
		const runDirectory = path.join(runsDirectory, runEntries[0].name);
		const state = JSON.parse(
			await readFile(path.join(runDirectory, "state.json"), "utf8"),
		);
		assert.equal(state.schemaVersion, 2);
		assert.equal("pendingDelegation" in state, false);
		const turnlockEvents = await readJsonLines(
			path.join(runDirectory, "events.ndjson"),
		);
		assert.equal(turnlockEvents.at(-1)?.eventType, "orchestrator_end");
		assert.equal(turnlockEvents.at(-1)?.success, true);
		const delegationNames = await readdir(
			path.join(runDirectory, "delegations"),
		);
		assert.equal(
			delegationNames.some((name) => name === "commit-jobs-0.json"),
			true,
		);
		assert.equal(
			delegationNames.some((name) => name.startsWith("commit-jobs-retry-")),
			true,
		);

		const requestEvents = await readJsonLines(requestLogPath);
		assert.deepEqual(
			requestEvents.map(({ callNumber }) => callNumber),
			[1, 2],
		);
		assert.equal(
			requestEvents.every(({ model }) => model === "gpt-5.4-mini"),
			true,
		);
		const telemetry = await readJsonLines(
			path.join(statsDirectory, "events.jsonl"),
		);
		const eventTypes = telemetry.map(({ eventType }) => eventType);
		for (const eventType of [
			"order_started",
			"run_start",
			"delegation",
			"run_end",
			"order_finished",
			"queue_empty",
		]) {
			assert.equal(eventTypes.includes(eventType), true, eventType);
		}
		assert.equal(
			telemetry.filter(({ eventType }) => eventType === "delegation").length,
			2,
		);
		const telemetryText = JSON.stringify(telemetry);
		assert.equal(telemetryText.includes(SYNTHETIC_API_KEY), false);

		const scannerTelemetry = await readJsonLines(
			path.join(scannerStatsDirectory, "events.jsonl"),
		);
		assert.equal(scannerTelemetry.at(-1)?.eventType, "passed");
		assert.equal(
			JSON.stringify(scannerTelemetry).includes(SYNTHETIC_API_KEY),
			false,
		);
		assert.equal((await stat(settingsPath)).isFile(), true);
		assert.equal(
			(await readdir(orderStateDirectory)).some(
				(name) => name.startsWith("order-") || name === "running.lock",
			),
			false,
		);
		assert.equal(await readFile(sentinelLogPath, "utf8").catch(() => ""), "");
	});
});
