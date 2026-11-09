import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	establishPreparedMergeCommit,
	publishEstablishedPreparedMerge,
} from "../../src/modules/git/prepared-merge-publisher.ts";
import { preparedMergeFixture } from "../fixtures/prepared-merge.ts";
import { git } from "../fixtures/targeted-create.ts";

test("ambiguous successful push observes exact M and never blindly retries", async () => {
	const f = preparedMergeFixture();
	const oldPath = process.env.PATH;
	try {
		const repo = establishPreparedMergeCommit(f.scope, await f.validated());
		const M = repo.committedShas?.[0]?.sha;
		assert.ok(M);
		const bin = path.join(f.root, ".git", "push-ack-bin");
		mkdirSync(bin);
		const actual = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const count = path.join(f.root, ".git", "push-attempts");
		writeFileSync(
			path.join(bin, "git"),
			`#!/bin/sh\nif [ "$1" = push ]; then echo attempt >> ${JSON.stringify(count)}; ${JSON.stringify(actual)} "$@"; result=$?; if [ "$result" = 0 ]; then exit 71; fi; exit "$result"; fi\nexec ${JSON.stringify(actual)} "$@"\n`,
			{ mode: 0o755 },
		);
		process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ""}`;
		assert.equal(
			publishEstablishedPreparedMerge(f.scope, repo).publishedSha,
			M,
		);
		assert.equal(readFileSync(count, "utf8"), "attempt\n");
		assert.equal(f.git(["rev-parse", "HEAD"]), M);
		assert.equal(git(f.remote, ["rev-parse", f.scope.pushRef]), M);
	} finally {
		if (oldPath === undefined) delete process.env.PATH;
		else process.env.PATH = oldPath;
		f.repo.dispose();
	}
});
