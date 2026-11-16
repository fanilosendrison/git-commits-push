import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { copyDeploymentSource } from "./fixtures/deployment-source.mjs";
import { resolvePathExecutable } from "./fixtures/path-executable.mjs";
import { resolvePnpmOfflineEnvironment } from "./fixtures/pnpm-offline-environment.mjs";
import { controlledInstall } from "./fixtures/standalone-pin-control.mjs";

const repository = path.resolve(import.meta.dirname, "../..");
const moduleUrl = (name) =>
	pathToFileURL(
		path.join(repository, "dist/src/modules/installation", `${name}.js`),
	).href;
const { installStandalone, activateStandaloneRelease } = await import(
	moduleUrl("standalone-installer")
);
const { digestReleaseTree } = await import(moduleUrl("release-tree"));
const { acquireInstallLock, releaseInstallLock } = await import(
	moduleUrl("install-lock")
);

async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), "gcp-release-pin-"));
	const pnpmCliPath =
		process.env.npm_execpath ?? (await resolvePathExecutable("pnpm"));
	const sourceDirectory = path.join(root, "source");
	await copyDeploymentSource(repository, sourceDirectory);
	const environment = {
		...resolvePnpmOfflineEnvironment(pnpmCliPath, repository),
		XDG_DATA_HOME: path.join(root, "data"),
	};
	const options = {
		environment,
		homeDirectory: path.join(root, "home"),
		pnpmCliPath,
		sourceDirectory,
	};
	const first = await installStandalone(options);
	return { root, options, first };
}

async function assertOldRelease(f) {
	assert.equal(
		await readlink(f.first.paths.currentReleaseLink),
		path.join("releases", f.first.releaseName),
	);
	assert.equal(
		await digestReleaseTree(f.first.releaseDirectory),
		f.first.releaseName.slice(-64),
	);
}

test("real deployment enforces the operator version/digest before changing current", async (t) => {
	const f = await fixture();
	try {
		await t.test(
			"correct expected identity reuses the verified existing release",
			async () => {
				const installed = await installStandalone({
					...f.options,
					expectedReleaseName: f.first.releaseName,
				});
				assert.equal(installed.releaseName, f.first.releaseName);
				assert.equal(installed.reusedRelease, true);
				await assertOldRelease(f);
			},
		);
		await t.test(
			"wrong expected digest refuses rather than selecting the computed release",
			async () => {
				const expectedReleaseName = `${f.first.releaseName.slice(0, -64)}${"0".repeat(64)}`;
				await assert.rejects(
					installStandalone({ ...f.options, expectedReleaseName }),
					/expected.*release|release.*expected/i,
				);
				await assertOldRelease(f);
			},
		);
		await t.test(
			"wrong expected version refuses even with the correct digest",
			async () => {
				const expectedReleaseName = `9999.0.0-${f.first.releaseName.slice(-64)}`;
				await assert.rejects(
					installStandalone({ ...f.options, expectedReleaseName }),
					/expected.*release|release.*expected/i,
				);
				await assertOldRelease(f);
			},
		);
		await t.test(
			"malformed expected identity refuses before installation",
			async () => {
				for (const expectedReleaseName of [
					"",
					"0.1.0-short",
					`01.2.3-${"a".repeat(64)}`,
					"../escape",
				]) {
					await assert.rejects(
						installStandalone({ ...f.options, expectedReleaseName }),
						/expected.*release|release.*expected/i,
					);
					await assertOldRelease(f);
				}
			},
		);
		await t.test(
			"a second installer cannot enter the held lifecycle lock",
			async () => {
				const owner = acquireInstallLock(f.first.paths.installLockPath);
				try {
					await assert.rejects(
						installStandalone({
							...f.options,
							expectedReleaseName: f.first.releaseName,
						}),
						/installer is active/,
					);
				} finally {
					releaseInstallLock(f.first.paths.installLockPath, owner);
				}
				await assertOldRelease(f);
			},
		);
		await t.test(
			"a changed source image cannot silently replace the pinned target",
			async () => {
				await writeFile(
					path.join(f.options.sourceDirectory, "dist", "pin-mutation.txt"),
					"synthetic changed image\n",
				);
				await assert.rejects(
					installStandalone({
						...f.options,
						expectedReleaseName: f.first.releaseName,
					}),
					/expected.*release|release.*expected/i,
				);
				await assertOldRelease(f);
				await rm(
					path.join(f.options.sourceDirectory, "dist", "pin-mutation.txt"),
				);
			},
		);
		await t.test(
			"the activation entrypoint refuses a tampered named tree",
			async () => {
				const candidate = path.join(f.root, "candidate");
				await mkdir(path.join(candidate, "bin"), { recursive: true });
				await writeFile(
					path.join(candidate, "bin/git-commits-push.mjs"),
					"#!/usr/bin/env node\n",
					{ mode: 0o755 },
				);
				await writeFile(
					path.join(candidate, "package.json"),
					JSON.stringify({ name: "git-commits-push", version: "0.1.0" }),
				);
				const releaseName = `0.1.0-${await digestReleaseTree(candidate)}`;
				const { rename } = await import("node:fs/promises");
				const destination = path.join(
					f.first.paths.releasesDirectory,
					releaseName,
				);
				await rename(candidate, destination);
				await writeFile(
					path.join(destination, "bin/git-commits-push.mjs"),
					"#!/usr/bin/env node\n// changed after naming\n",
				);
				await assert.rejects(
					activateStandaloneRelease(f.first.paths, releaseName),
					/digest|identity/i,
				);
				await assertOldRelease(f);
			},
		);
		await t.test(
			"a valid tree with a false version prefix cannot activate",
			async () => {
				const candidate = path.join(f.root, "false-version");
				await mkdir(path.join(candidate, "bin"), { recursive: true });
				await writeFile(
					path.join(candidate, "bin/git-commits-push.mjs"),
					"#!/usr/bin/env node\n",
					{ mode: 0o755 },
				);
				await writeFile(
					path.join(candidate, "package.json"),
					JSON.stringify({ name: "git-commits-push", version: "0.1.0" }),
				);
				const releaseName = `0.2.0-${await digestReleaseTree(candidate)}`;
				const { rename } = await import("node:fs/promises");
				await rename(
					candidate,
					path.join(f.first.paths.releasesDirectory, releaseName),
				);
				await assert.rejects(
					activateStandaloneRelease(f.first.paths, releaseName),
					/version|identity/i,
				);
				await assertOldRelease(f);
			},
		);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test("pinned installation retains intent and fencing across deployment and crash boundaries", async (t) => {
	const f = await fixture();
	const controls = [];
	try {
		await writeFile(
			path.join(f.options.sourceDirectory, "dist", "pin-candidate.txt"),
			"synthetic next image\n",
		);
		const golden = await mkdtemp(path.join(f.root, "qualified-candidate-"));
		const { buildStandaloneDeployment } = await import(
			moduleUrl("deployment-builder")
		);
		const built = await buildStandaloneDeployment({
			...f.options,
			targetDirectory: golden,
		});
		const expected = `${built.version}-${await digestReleaseTree(golden)}`;
		assert.notEqual(expected, f.first.releaseName);
		await t.test(
			"caller mutation during await cannot erase or replace the original pin",
			async () => {
				const wrong = `${built.version}-${"0".repeat(64)}`;
				const control = await controlledInstall(
					f,
					moduleUrl("standalone-installer"),
					wrong,
					expected,
				);
				controls.push(control);
				const result = await control.outcome();
				assert.equal(result.ok, false);
				assert.match(result.error, /expected.*release|release.*expected/i);
				await assertOldRelease(f);
			},
		);
		await t.test(
			"owner identity changed during deployment refuses before activation",
			async () => {
				const control = await controlledInstall(
					f,
					moduleUrl("standalone-installer"),
					expected,
				);
				controls.push(control);
				await control.entered();
				const record = `${f.first.paths.installLockPath}.owner`;
				const owner = JSON.parse(await readFile(record, "utf8"));
				owner.nonce = `${owner.nonce[0] === "a" ? "b" : "a"}${owner.nonce.slice(1)}`;
				await writeFile(record, JSON.stringify(owner));
				await control.release();
				const result = await control.outcome();
				assert.equal(result.ok, false);
				assert.match(result.error, /ownership changed/);
				await assertOldRelease(f);
			},
		);
		await t.test(
			"SIGKILL before activation preserves old current and permits fenced retry",
			async () => {
				const control = await controlledInstall(
					f,
					moduleUrl("standalone-installer"),
					expected,
				);
				controls.push(control);
				await control.crashAtDeployment();
				await assertOldRelease(f);
				const recovered = await installStandalone({
					...f.options,
					expectedReleaseName: expected,
				});
				assert.equal(recovered.releaseName, expected);
				assert.equal(
					await readlink(recovered.paths.currentReleaseLink),
					path.join("releases", expected),
				);
				assert.equal(
					await digestReleaseTree(recovered.releaseDirectory),
					built.digest,
				);
				assert.equal(
					await digestReleaseTree(f.first.releaseDirectory),
					f.first.releaseName.slice(-64),
				);
			},
		);
	} finally {
		for (const control of controls) await control.cleanup();
		await rm(f.root, { recursive: true, force: true });
	}
});

test("installer CLI parses an exact pin without an ignore or override route", async () => {
	const { parseExpectedStandaloneRelease } = await import(
		moduleUrl("install-arguments")
	);
	const name = `0.14.0-${"a".repeat(64)}`;
	assert.equal(parseExpectedStandaloneRelease([]), undefined);
	assert.equal(
		parseExpectedStandaloneRelease(["--expected-release", name]),
		name,
	);
	assert.equal(
		parseExpectedStandaloneRelease([`--expected-release=${name}`]),
		name,
	);
	for (const args of [
		["--expected-release"],
		["--expected-release", ""],
		["--expected-release", "bad"],
		["--expected-release", name, "--expected-release", name],
		["--expected-release", name, "--ignore-pin"],
		[name],
	])
		assert.throws(() => parseExpectedStandaloneRelease(args));
});
