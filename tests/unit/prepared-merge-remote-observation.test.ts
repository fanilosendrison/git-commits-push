import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	establishPreparedMergeCommit,
	publishEstablishedPreparedMerge,
} from "../../src/modules/git/prepared-merge-publisher.ts";
import { preparedMergeFixture } from "../fixtures/prepared-merge.ts";
import { git } from "../fixtures/targeted-create.ts";

test("review F3: source movement during remote observation refuses before the first send", async () => {
	const f = preparedMergeFixture();
	const oldPath = process.env.PATH;
	try {
		const repo = establishPreparedMergeCommit(f.scope, await f.validated());
		const bin = path.join(f.root, ".git", "remote-race-bin");
		mkdirSync(bin);
		const actual = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		writeFileSync(
			path.join(bin, "git"),
			`#!/bin/sh\nif [ "$1" = ls-remote ]; then ${JSON.stringify(actual)} "$@"; result=$?; echo foreign > ${JSON.stringify(path.join(f.root, "overlap"))}; exit "$result"; fi\nexec ${JSON.stringify(actual)} "$@"\n`,
			{ mode: 0o755 },
		);
		process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ""}`;
		assert.throws(
			() => publishEstablishedPreparedMerge(f.scope, repo),
			/changed|Worktree/,
		);
		assert.equal(
			git(f.remote, ["rev-parse", f.scope.pushRef]),
			f.D,
			"changed input must be refused before any publication",
		);
	} finally {
		if (oldPath === undefined) delete process.env.PATH;
		else process.env.PATH = oldPath;
		f.repo.dispose();
	}
});
