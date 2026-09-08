import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readlink,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
	acquireInstallLock,
	releaseInstallLock,
} from "../../src/modules/installation/install-lock.ts";
import {
	digestReleaseTree,
	validateReleaseTree,
} from "../../src/modules/installation/release-tree.ts";
import {
	activateStandaloneRelease,
	resolveStandaloneInstallPaths,
} from "../../src/modules/installation/standalone-installer.ts";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) => {
			await rm(directory, { force: true, recursive: true });
		}),
	);
});

describe("standalone install paths", () => {
	test("uses XDG data storage and a stable user-local executable", () => {
		const homeDirectory = path.join(path.sep, "tmp", "home-é");
		const paths = resolveStandaloneInstallPaths({
			environment: {
				XDG_DATA_HOME: path.join(homeDirectory, "custom data"),
			},
			homeDirectory,
		});
		assert.equal(
			paths.applicationDirectory,
			path.join(homeDirectory, "custom data", "git-commits-push"),
		);
		assert.equal(
			paths.currentReleaseLink,
			path.join(paths.applicationDirectory, "current"),
		);
		assert.equal(
			paths.publicExecutablePath,
			path.join(homeDirectory, ".local", "bin", "git-commits-push"),
		);
		assert.equal(
			paths.installLockPath,
			path.join(
				homeDirectory,
				".local",
				"bin",
				".git-commits-push-install.lock",
			),
		);
	});

	test("treats an empty XDG_DATA_HOME as absent and rejects relative values", () => {
		const homeDirectory = path.join(path.sep, "tmp", "home");
		assert.equal(
			resolveStandaloneInstallPaths({
				environment: { XDG_DATA_HOME: "" },
				homeDirectory,
			}).applicationDirectory,
			path.join(homeDirectory, ".local", "share", "git-commits-push"),
		);
		assert.throws(
			() =>
				resolveStandaloneInstallPaths({
					environment: { XDG_DATA_HOME: "relative/data" },
					homeDirectory,
				}),
			/XDG_DATA_HOME must resolve to an absolute path/,
		);
	});
});

describe("release tree integrity", () => {
	test("digest includes executable mode and internal symlink target", async () => {
		const root = await makeTemporaryDirectory("gcp-release-digest-é-");
		await mkdir(path.join(root, "bin"));
		const executable = path.join(root, "bin", "git-commits-push.mjs");
		await writeFile(executable, "#!/usr/bin/env node\n", { mode: 0o644 });
		await symlink("git-commits-push.mjs", path.join(root, "bin", "alias"));
		await validateReleaseTree(root);
		const nonExecutableDigest = await digestReleaseTree(root);
		await chmod(executable, 0o755);
		const executableDigest = await digestReleaseTree(root);
		assert.notEqual(executableDigest, nonExecutableDigest);
	});

	test("rejects a symlink that escapes the release", async () => {
		const parent = await makeTemporaryDirectory("gcp-release-escape-");
		const root = path.join(parent, "release");
		await mkdir(root);
		await writeFile(path.join(parent, "outside"), "outside\n");
		await symlink("../outside", path.join(root, "escape"));
		await assert.rejects(validateReleaseTree(root), /escapes the release tree/);
	});
});

describe("installation lock fencing", () => {
	test("rejects a matching live owner and only its owner can release", async () => {
		const root = await makeTemporaryDirectory("gcp-install-lock-");
		const lockPath = path.join(root, "install.lock");
		const owner = acquireInstallLock(lockPath);
		assert.throws(() => acquireInstallLock(lockPath), /installer is active/);
		assert.throws(
			() => releaseInstallLock(lockPath, { ...owner, nonce: "wrong" }),
			/ownership changed/,
		);
		releaseInstallLock(lockPath, owner);
	});

	test("recovers an atomically written lock after its owner is killed", async () => {
		const root = await makeTemporaryDirectory("gcp-install-lock-kill-");
		const lockPath = path.join(root, "install.lock");
		const fixturePath = path.resolve(
			import.meta.dirname,
			"../node-build/fixtures/install-lock-holder.mjs",
		);
		const moduleUrl = pathToFileURL(
			path.resolve(
				import.meta.dirname,
				"../../src/modules/installation/install-lock.ts",
			),
		).href;
		const child = spawn(process.execPath, [fixturePath, moduleUrl, lockPath], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		await new Promise<void>((resolve, reject) => {
			child.stdout.setEncoding("utf8");
			child.stdout.once("data", (chunk: string) => {
				if (chunk.startsWith("READY ")) resolve();
				else reject(new Error(`Unexpected lock fixture output: ${chunk}`));
			});
			child.once("error", reject);
		});
		child.kill("SIGKILL");
		await new Promise<void>((resolve) => child.once("close", () => resolve()));
		const staleCandidate = `${lockPath}.owner.candidate-${"e".repeat(32)}`;
		await writeFile(staleCandidate, "stale\n", { mode: 0o600 });
		const recoveredOwner = acquireInstallLock(lockPath);
		assert.equal(recoveredOwner.recovered, true);
		await assert.rejects(lstat(staleCandidate), { code: "ENOENT" });
		releaseInstallLock(lockPath, recoveredOwner);
	});

	test("allows only one simultaneous stale-lock recovery", async () => {
		const root = await makeTemporaryDirectory("gcp-install-lock-race-");
		const lockPath = path.join(root, "install.lock");
		const fixturePath = path.resolve(
			import.meta.dirname,
			"../node-build/fixtures/install-lock-holder.mjs",
		);
		const moduleUrl = pathToFileURL(
			path.resolve(
				import.meta.dirname,
				"../../src/modules/installation/install-lock.ts",
			),
		).href;
		const staleOwner = spawn(
			process.execPath,
			[fixturePath, moduleUrl, lockPath],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		await new Promise<void>((resolve, reject) => {
			staleOwner.stdout.setEncoding("utf8");
			staleOwner.stdout.once("data", () => resolve());
			staleOwner.once("error", reject);
		});
		staleOwner.kill("SIGKILL");
		await new Promise<void>((resolve) =>
			staleOwner.once("close", () => resolve()),
		);

		const contenders = Array.from({ length: 2 }, () =>
			spawn(process.execPath, [fixturePath, moduleUrl, lockPath, "500"], {
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
		const outcomes = await Promise.all(
			contenders.map(
				(child) =>
					new Promise<number | null>((resolve, reject) => {
						child.once("error", reject);
						child.once("close", (exitCode) => resolve(exitCode));
					}),
			),
		);
		assert.deepEqual(outcomes.sort(), [0, 1]);
	});
});

describe("release activation", () => {
	test("rejects truncated digests and ambiguous package versions", async () => {
		const root = await makeTemporaryDirectory("gcp-release-name-");
		const paths = resolveStandaloneInstallPaths({
			environment: { XDG_DATA_HOME: path.join(root, "data") },
			homeDirectory: path.join(root, "home"),
		});
		for (const releaseName of [
			"0.4.0-aaaaaaaa",
			`0.4.0-beta.1-${"a".repeat(64)}`,
			`01.2.3-${"a".repeat(64)}`,
		]) {
			await assert.rejects(
				activateStandaloneRelease(paths, releaseName),
				/Invalid standalone release name/,
			);
		}
	});

	test("refuses a hostile public entry before switching current", async () => {
		const root = await makeTemporaryDirectory("gcp-release-hostile-");
		const paths = resolveStandaloneInstallPaths({
			environment: { XDG_DATA_HOME: path.join(root, "data") },
			homeDirectory: path.join(root, "home"),
		});
		const releaseC = `0.4.0-${"c".repeat(64)}`;
		const releaseD = `0.4.0-${"d".repeat(64)}`;
		for (const releaseName of [releaseC, releaseD]) {
			const binDirectory = path.join(
				paths.releasesDirectory,
				releaseName,
				"bin",
			);
			await mkdir(binDirectory, { recursive: true });
			await writeFile(
				path.join(binDirectory, "git-commits-push.mjs"),
				"#!/usr/bin/env node\n",
				{ mode: 0o755 },
			);
		}
		await activateStandaloneRelease(paths, releaseC);
		await unlink(paths.publicExecutablePath);
		await writeFile(paths.publicExecutablePath, "hostile\n");
		await assert.rejects(
			activateStandaloneRelease(paths, releaseD),
			/Public executable path must be absent or the managed symlink/,
		);
		assert.equal(
			await readlink(paths.currentReleaseLink),
			path.join("releases", releaseC),
		);
	});

	test("switches only current and keeps the public executable stable", async () => {
		const root = await makeTemporaryDirectory("gcp-release-activation-");
		const homeDirectory = path.join(root, "home");
		const dataHome = path.join(root, "data");
		const paths = resolveStandaloneInstallPaths({
			environment: { XDG_DATA_HOME: dataHome },
			homeDirectory,
		});
		const releaseA = `0.4.0-${"a".repeat(64)}`;
		const releaseB = `0.4.0-${"b".repeat(64)}`;
		for (const releaseName of [releaseA, releaseB]) {
			const binDirectory = path.join(
				paths.releasesDirectory,
				releaseName,
				"bin",
			);
			await mkdir(binDirectory, { recursive: true });
			await writeFile(
				path.join(binDirectory, "git-commits-push.mjs"),
				`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(releaseName)});\n`,
				{ mode: 0o755 },
			);
		}
		await activateStandaloneRelease(paths, releaseA);
		const releaseAExecutable = path.join(
			paths.releasesDirectory,
			releaseA,
			"bin",
			"git-commits-push.mjs",
		);
		const publicTarget = await readlink(paths.publicExecutablePath);
		await activateStandaloneRelease(paths, releaseB);
		assert.equal(await readlink(paths.publicExecutablePath), publicTarget);
		assert.equal(
			await readlink(paths.currentReleaseLink),
			path.join("releases", releaseB),
		);
		assert.equal(
			publicTarget,
			path.relative(
				path.dirname(paths.publicExecutablePath),
				path.join(paths.currentReleaseLink, "bin", "git-commits-push.mjs"),
			),
		);
		assert.equal(
			spawnSync(releaseAExecutable, [], { encoding: "utf8" }).stdout,
			releaseA,
		);
		assert.equal(
			spawnSync(paths.publicExecutablePath, [], { encoding: "utf8" }).stdout,
			releaseB,
		);
	});
});
