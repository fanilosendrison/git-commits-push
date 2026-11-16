import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolvePathExecutable } from "./fixtures/path-executable.mjs";
import { resolvePnpmOfflineEnvironment } from "./fixtures/pnpm-offline-environment.mjs";

const repository = path.resolve(import.meta.dirname, "../..");
const installer = await import(
	pathToFileURL(
		path.join(
			repository,
			"dist/src/modules/installation/standalone-installer.js",
		),
	)
);
const { digestReleaseTree } = await import(
	pathToFileURL(
		path.join(repository, "dist/src/modules/installation/release-tree.js"),
	)
);

test("official source CLI forwards the exact pin through real deployment", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "gcp-pin-cli-"));
	try {
		const pnpmCliPath =
			process.env.npm_execpath ?? (await resolvePathExecutable("pnpm"));
		const home = path.join(root, "home");
		const environment = {
			...resolvePnpmOfflineEnvironment(pnpmCliPath, repository),
			HOME: home,
			XDG_DATA_HOME: path.join(root, "data"),
			XDG_STATE_HOME: path.join(root, "state"),
			TURNLOCK_RUN_DIR_ROOT: path.join(root, "runs"),
			npm_execpath: pnpmCliPath,
		};
		const first = await installer.installStandalone({
			environment,
			homeDirectory: home,
			pnpmCliPath,
			sourceDirectory: repository,
		});
		const invoke = (expected) =>
			spawnSync(
				process.execPath,
				[
					path.join(repository, "scripts/install-standalone.mjs"),
					"--expected-release",
					expected,
				],
				{
					cwd: repository,
					env: environment,
					encoding: "utf8",
					shell: false,
					timeout: 60_000,
				},
			);
		const wrong = `${first.releaseName.slice(0, -64)}${"0".repeat(64)}`;
		const refused = invoke(wrong);
		assert.notEqual(refused.status, 0);
		assert.equal(refused.signal, null);
		assert.match(refused.stderr, /does not match the expected release/);
		assert.equal(
			await readlink(first.paths.currentReleaseLink),
			path.join("releases", first.releaseName),
		);
		const accepted = invoke(first.releaseName);
		assert.equal(accepted.status, 0, accepted.stderr);
		assert.equal(accepted.signal, null);
		assert.ok(
			accepted.stdout.includes(
				`Installed git-commits-push ${first.releaseName}`,
			),
		);
		assert.equal(
			await readlink(first.paths.currentReleaseLink),
			path.join("releases", first.releaseName),
		);
		assert.equal(
			await digestReleaseTree(first.releaseDirectory),
			first.releaseName.slice(-64),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
