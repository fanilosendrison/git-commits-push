import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveGitExecutable } from "../../src/modules/git/git-executable.ts";
import { runNodeWithPlatformGit } from "../../src/modules/qualification/platform-git.ts";

const wrapper = path.resolve(
	import.meta.dirname,
	"../../scripts/with-platform-git.mjs",
);

test("contributor wrapper applies the official Git policy and preserves literal Node arguments", () => {
	const root = mkdtempSync(path.join(tmpdir(), "qualification-git-"));
	try {
		writeFileSync(
			path.join(root, "git"),
			"#!/bin/sh\nprintf 'synthetic-ambient-git\\n'\n",
			{ mode: 0o755 },
		);
		const args = ["space name", "-leading", "glob[*]", "quote'key"];
		const program =
			"console.log(JSON.stringify({argv:process.argv.slice(1),git:require('node:child_process').execFileSync('git',['--version'],{encoding:'utf8'}).trim()}))";
		const result = spawnSync(
			process.execPath,
			[wrapper, "-e", program, "--", ...args],
			{
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
				},
				timeout: 30_000,
			},
		);
		assert.equal(result.status, 0, result.stderr);
		const observed = JSON.parse(result.stdout);
		assert.deepEqual(observed.argv, args);
		const legacy =
			process.platform === "darwin" && Number(release().split(".")[0]) <= 17;
		const expected = legacy
			? execFileSync(resolveGitExecutable(), ["--version"], {
					encoding: "utf8",
				}).trim()
			: "synthetic-ambient-git";
		assert.equal(observed.git, expected);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("platform selection is restored and an unsuccessful child remains unsuccessful", async () => {
	const original = process.env.PATH;
	const result = await runNodeWithPlatformGit(["-e", "process.exit(7)"]);
	assert.equal(result.exitCode, 7);
	assert.equal(result.signal, null);
	assert.equal(process.env.PATH, original);
});
