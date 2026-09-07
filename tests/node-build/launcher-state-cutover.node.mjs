import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "../..");
const compiledSkillDirectory = path.join(skillDirectory, "dist");
const nodeLauncherPath = path.join(skillDirectory, "scripts", "start-node.mjs");

async function withTemporaryDirectory(callback) {
	const directory = await mkdtemp(path.join(tmpdir(), "launcher-cutover-é-"));
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

function supervisorArtifactPath() {
	return path.join(
		compiledSkillDirectory,
		"src",
		"entrypoints",
		"node-supervisor.js",
	);
}

test("state migration lock blocks admission before any SQLite or build work", async () => {
	await withTemporaryDirectory(async (root) => {
		const environment = isolatedEnvironment(root);
		const stateHome = path.join(root, "state home");
		const applicationStateDirectory = path.join(stateHome, "git-commits-push");
		const migrationLockPath = `${applicationStateDirectory}.migration-lock`;
		await mkdir(environment.HOME, { recursive: true });
		await mkdir(environment.XDG_CONFIG_HOME, { recursive: true });
		await mkdir(migrationLockPath, { recursive: true });
		const supervisorArtifact = supervisorArtifactPath();
		const artifactMtime = statSync(supervisorArtifact).mtimeMs;

		const result = spawnSync(process.execPath, [nodeLauncherPath], {
			cwd: skillDirectory,
			encoding: "utf8",
			env: {
				...environment,
				PI_SESSION_ID: "migration-lock-held",
				XDG_STATE_HOME: stateHome,
			},
			shell: false,
			timeout: 60_000,
		});

		assert.strictEqual(result.status, 2, result.stderr);
		assert.match(result.stderr, /state migration lock is already held/iu);
		assert.strictEqual(existsSync(applicationStateDirectory), false);
		assert.strictEqual(statSync(supervisorArtifact).mtimeMs, artifactMtime);
	});
});

test("malformed legacy lock releases the state cutover lock", async () => {
	await withTemporaryDirectory(async (root) => {
		const environment = isolatedEnvironment(root);
		const stateHome = path.join(root, "state home");
		const applicationStateDirectory = path.join(stateHome, "git-commits-push");
		const orderStateDirectory = path.join(applicationStateDirectory, "orders");
		const legacyLockPath = path.join(orderStateDirectory, "running.lock");
		await mkdir(environment.HOME, { recursive: true });
		await mkdir(environment.XDG_CONFIG_HOME, { recursive: true });
		await mkdir(orderStateDirectory, { recursive: true });
		await writeFile(legacyLockPath, "not-json\n");
		const supervisorArtifact = supervisorArtifactPath();
		const artifactMtime = statSync(supervisorArtifact).mtimeMs;

		const result = spawnSync(process.execPath, [nodeLauncherPath], {
			cwd: skillDirectory,
			encoding: "utf8",
			env: {
				...environment,
				PI_SESSION_ID: "malformed-legacy-lock",
				XDG_STATE_HOME: stateHome,
			},
			shell: false,
			timeout: 60_000,
		});

		assert.strictEqual(result.status, 2, result.stderr);
		assert.match(result.stderr, /legacy queue lock.*malformed/u);
		assert.strictEqual(await readFile(legacyLockPath, "utf8"), "not-json\n");
		assert.strictEqual(
			existsSync(path.join(orderStateDirectory, "reconciler.sqlite")),
			false,
		);
		assert.strictEqual(statSync(supervisorArtifact).mtimeMs, artifactMtime);
		assert.strictEqual(
			existsSync(`${applicationStateDirectory}.migration-lock`),
			false,
		);
	});
});
