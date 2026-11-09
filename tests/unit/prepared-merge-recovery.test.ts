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

test("lost object acknowledgement and discarded application acknowledgement retain one exact M", async () => {
	const f = preparedMergeFixture();
	const oldPath = process.env.PATH;
	try {
		const repo = await f.validated();
		const bin = path.join(f.root, ".git", "lost-ack-bin");
		mkdirSync(bin);
		const actual = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const count = path.join(f.root, ".git", "commit-attempts");
		writeFileSync(
			path.join(bin, "git"),
			`#!/bin/sh\nif [ "$2" = commit-tree ]; then echo attempt >> ${JSON.stringify(count)}; ${JSON.stringify(actual)} "$@"; result=$?; if [ "$result" = 0 ]; then exit 71; fi; exit "$result"; fi\nexec ${JSON.stringify(actual)} "$@"\n`,
			{ mode: 0o755 },
		);
		process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ""}`;
		establishPreparedMergeCommit(f.scope, repo);
		const M = f.git(["rev-parse", "HEAD"]);
		const recovered = establishPreparedMergeCommit(f.scope, repo);
		assert.equal(recovered.committedShas?.[0]?.sha, M);
		assert.equal(M, repo.validatedSource?.preparedMerge?.expectedCommitSha);
		assert.equal(readFileSync(count, "utf8"), "attempt\n");
		assert.equal(
			f.git(["rev-list", "--first-parent", "--count", `${f.D}..HEAD`]),
			"1",
		);
		assert.equal(git(f.remote, ["rev-parse", f.scope.pushRef]), f.D);
	} finally {
		if (oldPath === undefined) delete process.env.PATH;
		else process.env.PATH = oldPath;
		f.repo.dispose();
	}
});

test("post-commit recovery publishes only frozen M and observes already-published M without a new commit", async () => {
	const f = preparedMergeFixture();
	try {
		const repo = establishPreparedMergeCommit(f.scope, await f.validated());
		const M = repo.committedShas?.[0]?.sha;
		assert.ok(M);
		const first = publishEstablishedPreparedMerge(f.scope, repo);
		assert.equal(first.publishedSha, M);
		const second = publishEstablishedPreparedMerge(f.scope, repo);
		assert.equal(second.publishedSha, M);
		assert.equal(f.git(["rev-parse", "HEAD"]), M);
		assert.equal(git(f.remote, ["rev-parse", f.scope.pushRef]), M);
	} finally {
		f.repo.dispose();
	}
});
