import assert from "node:assert/strict";
import {
	chmodSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gitExecArgs } from "../../src/modules/git/git-exec.ts";
import {
	activateGitExecutableForProcess,
	type GitExecutableActivation,
	resolveGitExecutable,
} from "../../src/modules/git/git-executable.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";

function createVersionedGit(version: string): {
	readonly directory: string;
	readonly executable: string;
} {
	const directory = mkdtempSync(path.join(os.tmpdir(), "gcp-git-executable-"));
	const executable = path.join(directory, "git");
	writeFileSync(
		executable,
		`#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(`git version ${version}`)}\n`,
	);
	chmodSync(executable, 0o755);
	return { directory, executable };
}

test("legacy Darwin selects and validates the Apple toolchain Git", () => {
	const fixture = createVersionedGit("2.17.2 (Apple Git-113)");
	try {
		const executable = resolveGitExecutable({
			platform: "darwin",
			kernelRelease: "17.7.0",
			resolveDeveloperGit: () => fixture.executable,
		});
		assert.equal(executable, realpathSync(fixture.executable));
	} finally {
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});

test("legacy Darwin activation routes production Git calls through Apple Git", () => {
	const fixture = createVersionedGit("2.17.2 (Apple Git-113)");
	const originalPath = process.env.PATH;
	let activation: GitExecutableActivation | undefined;
	try {
		activation = activateGitExecutableForProcess({
			platform: "darwin",
			kernelRelease: "17.7.0",
			resolveDeveloperGit: () => fixture.executable,
		});
		assert.equal(
			gitExecArgs(["--version"], fixture.directory),
			"git version 2.17.2 (Apple Git-113)",
		);
	} finally {
		activation?.restore();
		rmSync(fixture.directory, { recursive: true, force: true });
	}
	assert.equal(process.env.PATH, originalPath);
});

test("legacy Darwin fails closed when Apple Git is too old", () => {
	const fixture = createVersionedGit("2.16.6");
	try {
		assert.throws(
			() =>
				resolveGitExecutable({
					platform: "darwin",
					kernelRelease: "17.7.0",
					resolveDeveloperGit: () => fixture.executable,
				}),
			/requires Git >= 2\.17\.0/u,
		);
	} finally {
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});

test("non-legacy platforms preserve PATH Git without invoking xcrun", () => {
	let resolverCalled = false;
	assert.equal(
		resolveGitExecutable({
			platform: "darwin",
			kernelRelease: "18.0.0",
			resolveDeveloperGit: () => {
				resolverCalled = true;
				return "unreachable";
			},
		}),
		"git",
	);
	assert.equal(resolverCalled, false);
});

test("Git process diagnostics use the stable C locale", () => {
	const repository = GitRepoFixture.create();
	try {
		assert.throws(
			() => gitExecArgs(["add", "--", "missing-file"], repository.dir),
			/pathspec .* did not match any files/u,
		);
	} finally {
		repository.dispose();
	}
});

test("Git process config preserves ambient entries with Git 2.17 quoting", () => {
	const repository = GitRepoFixture.create();
	const originalParameters = process.env.GIT_CONFIG_PARAMETERS;
	const complexValue =
		"https://user:dummy-secret@example.test/a path\\repo's.git";
	process.env.GIT_CONFIG_PARAMETERS = "'gcp.ambient=preserved'";
	try {
		assert.strictEqual(
			gitExecArgs(["config", "--get", "gcp.ambient"], repository.dir, [
				{ key: "gcp.added", value: complexValue },
			]),
			"preserved",
		);
		assert.strictEqual(
			gitExecArgs(["config", "--get", "gcp.added"], repository.dir, [
				{ key: "gcp.added", value: complexValue },
			]),
			complexValue,
		);
	} finally {
		if (originalParameters === undefined) {
			delete process.env.GIT_CONFIG_PARAMETERS;
		} else {
			process.env.GIT_CONFIG_PARAMETERS = originalParameters;
		}
		repository.dispose();
	}
});
