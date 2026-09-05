import assert from "node:assert/strict";
import { test } from "node:test";
import { gitExecArgs } from "../../src/modules/git/git-exec.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";

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
