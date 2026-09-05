import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
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
	"mock-openai-fetch-reconciler.mjs",
);

async function withTemporaryDirectory(callback) {
	const directory = await mkdtemp(path.join(tmpdir(), "launcher-admission-é-"));
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

test("I0 | malformed legacy lock blocks admission before any build", async () => {
	await withTemporaryDirectory(async (root) => {
		const environment = isolatedEnvironment(root);
		await mkdir(environment.HOME, { recursive: true });
		await mkdir(environment.XDG_CONFIG_HOME, { recursive: true });
		const orderStateDirectory = path.join(root, "reconciler state");
		await mkdir(orderStateDirectory, { recursive: true });
		const lockPath = path.join(orderStateDirectory, "running.lock");
		await writeFile(lockPath, "not-json\n");
		const supervisorArtifact = path.join(
			compiledSkillDirectory,
			"src",
			"entrypoints",
			"node-supervisor.js",
		);
		const artifactMtime = statSync(supervisorArtifact).mtimeMs;

		const result = spawnSync(process.execPath, [nodeLauncherPath], {
			cwd: skillDirectory,
			encoding: "utf8",
			env: {
				...environment,
				ORDER_STATE_DIR: orderStateDirectory,
				PI_SESSION_ID: "malformed-legacy-lock",
			},
			shell: false,
			timeout: 60_000,
		});

		assert.strictEqual(result.status, 2, result.stderr);
		assert.match(result.stderr, /legacy queue lock.*malformed/u);
		assert.strictEqual(await readFile(lockPath, "utf8"), "not-json\n");
		assert.strictEqual(
			existsSync(path.join(orderStateDirectory, "reconciler.sqlite")),
			false,
		);
		assert.strictEqual(statSync(supervisorArtifact).mtimeMs, artifactMtime);
	});
});

test("I0b | SIGTERM during build releases ownership without completion", async () => {
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
				if (!String(error).includes("database is locked")) throw error;
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
