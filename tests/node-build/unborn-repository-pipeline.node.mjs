import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePathExecutable } from "./fixtures/path-executable.mjs";
import { resolvePnpmOfflineEnvironment } from "./fixtures/pnpm-offline-environment.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceDirectory = path.resolve(testDirectory, "../..");
const compiledInstallerUrl = pathToFileURL(
	path.join(
		sourceDirectory,
		"dist",
		"src",
		"modules",
		"installation",
		"standalone-installer.js",
	),
).href;
const mockFetchPreloadPath = path.join(
	testDirectory,
	"fixtures",
	"mock-openai-fetch-unborn.mjs",
);
const SYNTHETIC_API_KEY = `sk-${"U".repeat(48)}`;

async function withTemporaryDirectory(callback) {
	const directory = await mkdtemp(
		path.join(tmpdir(), "compiled-unborn-repository-é-"),
	);
	try {
		await callback(directory);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
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

test("compiled launcher creates and publishes an initial commit", async () => {
	await withTemporaryDirectory(async (root) => {
		const pnpmCliPath =
			process.env.npm_execpath ?? (await resolvePathExecutable("pnpm"));
		const homeDirectory = path.join(root, "isolated home");
		const configDirectory = path.join(root, "isolated config");
		const environment = {
			...resolvePnpmOfflineEnvironment(pnpmCliPath, sourceDirectory),
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			HOME: homeDirectory,
			XDG_CONFIG_HOME: configDirectory,
			XDG_DATA_HOME: path.join(root, "installed application data"),
		};
		await mkdir(homeDirectory, { recursive: true });
		await mkdir(configDirectory, { recursive: true });
		const { installStandalone } = await import(compiledInstallerUrl);
		const installation = await installStandalone({
			environment,
			homeDirectory,
			pnpmCliPath,
			sourceDirectory,
		});

		const searchRoot = path.join(root, "search root 漢字");
		const repositoryPath = path.join(searchRoot, "unborn repository é");
		const bareRemotePath = path.join(root, "empty remote 漢字.git");
		await mkdir(repositoryPath, { recursive: true });
		await mkdir(bareRemotePath, { recursive: true });
		runGit(bareRemotePath, ["init", "--bare", "--quiet"], environment);
		runGit(repositoryPath, ["init", "--quiet"], environment);
		runGit(
			repositoryPath,
			["config", "user.name", "Unborn Pipeline"],
			environment,
		);
		runGit(
			repositoryPath,
			["config", "user.email", "unborn-pipeline@example.invalid"],
			environment,
		);
		await writeFile(
			path.join(repositoryPath, "README.md"),
			"# Initial project\n",
		);
		runGit(repositoryPath, ["add", "README.md"], environment);
		runGit(
			repositoryPath,
			["remote", "add", "origin", bareRemotePath],
			environment,
		);

		const stateDirectory = path.join(root, "order state");
		const runDirectory = path.join(root, "turnlock runs");
		const statsDirectory = path.join(root, "stats");
		const scannerStatsDirectory = path.join(root, "scanner stats");
		const enforcerStatsDirectory = path.join(root, "enforcer stats");
		const temporaryDirectory = path.join(root, "temporary files");
		for (const directory of [
			stateDirectory,
			runDirectory,
			statsDirectory,
			scannerStatsDirectory,
			enforcerStatsDirectory,
			temporaryDirectory,
		]) {
			await mkdir(directory, { recursive: true });
		}
		const settingsPath = path.join(root, "settings.json");
		await writeFile(
			settingsPath,
			JSON.stringify({
				autoPush: true,
				model: "gpt-5.4-mini",
				provider: "openai",
				searchPaths: [searchRoot],
				skipTests: true,
				systemPromptPath: path.join(
					installation.releaseDirectory,
					"dist",
					"system-prompt.md",
				),
				temperature: 0,
			}),
		);

		const pipeline = spawnSync(installation.paths.publicExecutablePath, [], {
			cwd: repositoryPath,
			encoding: "utf8",
			env: {
				...environment,
				GIT_COMMITS_PUSH_ENFORCER_STATS_DIR: enforcerStatsDirectory,
				NODE_OPTIONS: `--import=${pathToFileURL(mockFetchPreloadPath).href}`,
				OPENAI_API_KEY: SYNTHETIC_API_KEY,
				ORDER_STATE_DIR: stateDirectory,
				PI_SESSION_ID: "compiled-unborn-repository",
				PI_SKILL_STATS_DIR: statsDirectory,
				SECRET_SCANNER_STATS_DIR: scannerStatsDirectory,
				TEMP: temporaryDirectory,
				TMP: temporaryDirectory,
				TMPDIR: temporaryDirectory,
				TURNLOCK_RUN_DIR_ROOT: runDirectory,
				TURNLOCK_SKILL_SETTINGS_PATH: settingsPath,
			},
			maxBuffer: 50 * 1024 * 1024,
			shell: false,
			timeout: 90_000,
		});
		assert.equal(
			pipeline.status,
			0,
			`compiled pipeline failed: ${pipeline.stderr}\n${pipeline.stdout}`,
		);
		assert.match(pipeline.stdout, /action: DONE/u);
		assert.doesNotMatch(pipeline.stdout, /action: ERROR/u);
		assert.equal(pipeline.stdout.includes(SYNTHETIC_API_KEY), false);
		assert.equal(pipeline.stderr.includes(SYNTHETIC_API_KEY), false);

		const branch = runGit(
			repositoryPath,
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			environment,
		);
		const localHead = runGit(
			repositoryPath,
			["rev-parse", "HEAD"],
			environment,
		);
		assert.equal(
			runGit(
				bareRemotePath,
				["rev-parse", `refs/heads/${branch}`],
				environment,
			),
			localHead,
		);
		assert.equal(
			runGit(repositoryPath, ["rev-parse", "@{upstream}"], environment),
			localHead,
		);
		assert.equal(
			runGit(repositoryPath, ["rev-list", "--count", "HEAD"], environment),
			"1",
		);
		assert.equal(
			runGit(repositoryPath, ["log", "-1", "--pretty=%s"], environment),
			"docs: create initial project documentation",
		);
		assert.equal(
			runGit(repositoryPath, ["status", "--porcelain"], environment),
			"",
		);
		assert.equal((await readFile(settingsPath, "utf8")).length > 0, true);
	});
});
