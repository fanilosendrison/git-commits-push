import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmod,
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePathExecutable } from "./fixtures/path-executable.mjs";
import { resolvePnpmOfflineEnvironment } from "./fixtures/pnpm-offline-environment.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(testDirectory, "../..");
const compiledInstallerUrl = pathToFileURL(
	path.join(
		repositoryDirectory,
		"dist",
		"src",
		"modules",
		"installation",
		"standalone-installer.js",
	),
).href;

async function findEscapingLinks(rootDirectory) {
	const escapes = [];
	async function visit(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(entryPath);
				continue;
			}
			if (!entry.isSymbolicLink()) continue;
			const target = await readlink(entryPath);
			const resolved = path.resolve(path.dirname(entryPath), target);
			const relative = path.relative(rootDirectory, resolved);
			if (
				path.isAbsolute(target) ||
				relative === ".." ||
				relative.startsWith(`..${path.sep}`)
			) {
				escapes.push(`${entryPath} -> ${target}`);
			}
		}
	}
	await visit(rootDirectory);
	return escapes;
}

function writeExecutable(pathname, content) {
	return writeFile(pathname, content, { mode: 0o755 }).then(async () => {
		await chmod(pathname, 0o755);
	});
}

async function copyDeploymentSource(targetDirectory) {
	await mkdir(targetDirectory, { recursive: true });
	for (const entry of [
		".npmrc",
		"bin",
		"dist",
		"package.json",
		"pnpm-lock.yaml",
		"pnpm-workspace.yaml",
	]) {
		await cp(
			path.join(repositoryDirectory, entry),
			path.join(targetDirectory, entry),
			{ recursive: true },
		);
	}
	for (const packageName of ["node-runtime", "trust"]) {
		const targetPackageDirectory = path.join(
			targetDirectory,
			"packages",
			packageName,
		);
		await mkdir(targetPackageDirectory, { recursive: true });
		for (const entry of ["dist", "package.json"]) {
			await cp(
				path.join(repositoryDirectory, "packages", packageName, entry),
				path.join(targetPackageDirectory, entry),
				{ recursive: true },
			);
		}
	}
}

test("installs and runs a checkout-independent production deployment", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "gcp-standalone-install-é-"));
	try {
		const pnpmCliPath =
			process.env.npm_execpath ?? (await resolvePathExecutable("pnpm"));
		const homeDirectory = path.join(root, "isolated home");
		const dataHome = path.join(root, "isolated data");
		const sourceCheckout = path.join(root, "source checkout");
		await copyDeploymentSource(sourceCheckout);
		const environment = {
			...resolvePnpmOfflineEnvironment(pnpmCliPath, repositoryDirectory),
			XDG_DATA_HOME: dataHome,
		};
		const { installStandalone } = await import(compiledInstallerUrl);
		const firstInstall = await installStandalone({
			environment,
			homeDirectory,
			pnpmCliPath,
			sourceDirectory: sourceCheckout,
		});
		assert.equal(firstInstall.reusedRelease, false);
		assert.equal(
			(await lstat(firstInstall.paths.publicExecutablePath)).isSymbolicLink(),
			true,
		);
		assert.equal(
			(await lstat(firstInstall.paths.currentReleaseLink)).isSymbolicLink(),
			true,
		);
		assert.deepEqual(
			await findEscapingLinks(firstInstall.releaseDirectory),
			[],
		);

		for (const relativePath of [
			"bin/git-commits-push.mjs",
			"dist/src/entrypoints/git-commits-push.js",
			"dist/src/entrypoints/node-supervisor.js",
			"dist/src/entrypoints/turnlock-orchestrator.js",
			"dist/src/entrypoints/turnlock-to-llm-bridge.js",
			"dist/src/config/settings.json",
			"dist/system-prompt.md",
			"node_modules/@git-commits-push/node-runtime/dist/index.js",
			"node_modules/@git-commits-push/trust/dist/index.js",
		]) {
			assert.equal(
				(
					await lstat(path.join(firstInstall.releaseDirectory, relativePath))
				).isFile(),
				true,
				relativePath,
			);
		}
		for (const excludedPath of ["src", "scripts", "tests", "packages"]) {
			await assert.rejects(
				lstat(path.join(firstInstall.releaseDirectory, excludedPath)),
				{ code: "ENOENT" },
			);
		}
		assert.equal(
			(
				await lstat(
					path.join(
						firstInstall.releaseDirectory,
						"bin",
						"git-commits-push.mjs",
					),
				)
			).mode & 0o111,
			0o111,
		);

		const publicTarget = await readlink(
			firstInstall.paths.publicExecutablePath,
		);
		const staleStagingDirectory = path.join(
			firstInstall.paths.releasesDirectory,
			`.staging-${"e".repeat(32)}`,
		);
		await mkdir(staleStagingDirectory);
		await writeFile(path.join(staleStagingDirectory, "residue"), "stale\n");
		const secondInstall = await installStandalone({
			environment,
			homeDirectory,
			pnpmCliPath,
			sourceDirectory: sourceCheckout,
		});
		assert.equal(secondInstall.reusedRelease, true);
		assert.equal(secondInstall.releaseDirectory, firstInstall.releaseDirectory);
		await assert.rejects(lstat(staleStagingDirectory), { code: "ENOENT" });
		assert.equal(
			await readlink(secondInstall.paths.publicExecutablePath),
			publicTarget,
		);
		await rename(
			sourceCheckout,
			path.join(root, "source checkout unavailable"),
		);
		await assert.rejects(lstat(sourceCheckout), { code: "ENOENT" });

		const searchRoot = path.join(root, "empty search root");
		const orderStateDirectory = path.join(root, "order state");
		const turnlockRoot = path.join(root, "turnlock runs");
		const settingsPath = path.join(root, "settings.json");
		const sentinelDirectory = path.join(root, "sentinels");
		const sentinelLog = path.join(root, "sentinel.log");
		for (const directory of [
			homeDirectory,
			searchRoot,
			orderStateDirectory,
			turnlockRoot,
			sentinelDirectory,
		]) {
			await mkdir(directory, { recursive: true });
		}
		for (const command of ["pnpm", "bun"]) {
			await writeExecutable(
				path.join(sentinelDirectory, command),
				`#!/bin/sh\nprintf '%s\\n' '${command}' >> "$RUNTIME_SENTINEL_LOG"\nexit 97\n`,
			);
		}
		await writeFile(
			settingsPath,
			JSON.stringify({
				agent: "git-commits-push",
				autoPush: true,
				model: "unused",
				provider: "unused",
				searchPaths: [searchRoot],
				skipTests: true,
				systemPromptPath: path.join(
					firstInstall.releaseDirectory,
					"dist",
					"system-prompt.md",
				),
				temperature: 0,
			}),
		);
		const runtimeEnvironment = {
			...environment,
			HOME: homeDirectory,
			XDG_DATA_HOME: "",
			ORDER_STATE_DIR: orderStateDirectory,
			PATH: `${sentinelDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
			RUNTIME_SENTINEL_LOG: sentinelLog,
			TURNLOCK_RUN_DIR_ROOT: turnlockRoot,
			TURNLOCK_SKILL_SETTINGS_PATH: settingsPath,
		};
		const run = spawnSync(firstInstall.paths.publicExecutablePath, [], {
			cwd: root,
			encoding: "utf8",
			env: runtimeEnvironment,
			maxBuffer: 10 * 1024 * 1024,
			shell: false,
			timeout: 60_000,
		});
		assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
		assert.equal(run.signal, null);
		assert.match(run.stderr, /No repositories with changes found/);
		assert.match(run.stderr, /"eventType":"orchestrator_end"/);
		await assert.rejects(readFile(sentinelLog, "utf8"), { code: "ENOENT" });
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
