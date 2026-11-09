import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { commitPlanMessage } from "../../src/modules/git/commit-plan-message.ts";
import { establishPreparedMergeCommit } from "../../src/modules/git/prepared-merge-publisher.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { preparedMergeFixture } from "../fixtures/prepared-merge.ts";
import { git } from "../fixtures/targeted-create.ts";

test("historical message-file cleanup cannot erase a completed Git commit acknowledgement", (t) => {
	const repo = GitRepoFixture.create();
	const original = fs.rmSync;
	const cleanup: Parameters<typeof fs.rmSync>[0][] = [];
	try {
		repo.commit("base");
		const before = git(repo.dir, ["rev-parse", "HEAD"]);
		repo.writeAndStage("work.txt", "validated bytes\n");
		const tree = git(repo.dir, ["write-tree"]);
		t.mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => {
			if (String(args[0]).includes("gcp-plan-message-")) {
				cleanup.push(args[0]);
				throw new Error("fixture private-message cleanup refusal");
			}
			return original(...args);
		});
		syncBuiltinESMExports();
		assert.doesNotThrow(() =>
			commitPlanMessage(repo.dir, "test: preserve commit acknowledgement"),
		);
		assert.equal(cleanup.length, 1);
		assert.notEqual(git(repo.dir, ["rev-parse", "HEAD"]), before);
		assert.equal(git(repo.dir, ["rev-parse", "HEAD^{tree}"]), tree);
		assert.equal(
			git(repo.dir, ["rev-list", "--count", `${before}..HEAD`]),
			"1",
		);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		for (const directory of cleanup)
			original(directory, { recursive: true, force: true });
		repo.dispose();
	}
});

test("prepared message cleanup cannot replace exact object identity with a false effect failure", async (t) => {
	const f = preparedMergeFixture();
	const original = fs.rmSync;
	const cleanup: Parameters<typeof fs.rmSync>[0][] = [];
	try {
		const repo = await f.validated();
		t.mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => {
			if (String(args[0]).includes("gcp-prepared-merge-message-")) {
				cleanup.push(args[0]);
				throw new Error("fixture private-message cleanup refusal");
			}
			return original(...args);
		});
		syncBuiltinESMExports();
		const result = establishPreparedMergeCommit(f.scope, repo);
		assert.equal(cleanup.length, 1);
		assert.equal(
			result.committedShas?.[0]?.sha,
			repo.validatedSource?.preparedMerge?.expectedCommitSha,
		);
		assert.equal(f.git(["rev-parse", "HEAD^{tree}"]), f.T);
		assert.equal(f.git(["show", "-s", "--format=%P", "HEAD"]), `${f.D} ${f.C}`);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		for (const directory of cleanup)
			original(directory, { recursive: true, force: true });
		f.repo.dispose();
	}
});
