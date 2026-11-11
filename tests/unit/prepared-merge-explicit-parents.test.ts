import assert from "node:assert/strict";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { establishPreparedMergeCommit } from "../../src/modules/git/prepared-merge-publisher.ts";
import { validatePreparedMerge } from "../../src/modules/git/prepared-merge-validation.ts";
import { preparedMergeFixture } from "../fixtures/prepared-merge.ts";
import { CREATE_SETTINGS } from "../fixtures/targeted-create.ts";

test("review F2: optional MERGE_MODE cannot remove an explicitly required ancestral second parent", async () => {
	const f = preparedMergeFixture();
	try {
		writeFileSync(f.gitPath("MERGE_HEAD"), `${f.B}\n`);
		if (existsSync(f.gitPath("MERGE_MODE")))
			unlinkSync(f.gitPath("MERGE_MODE"));
		const scope = { ...f.scope, secondParent: f.B };
		const { witness, target } = await validatePreparedMerge(
			scope,
			CREATE_SETTINGS,
		);
		const repo = establishPreparedMergeCommit(scope, {
			repository: f.root,
			operation: "commit-and-push",
			status: "RUNNING",
			validatedSource: witness,
			explicitPushTargetSnapshot: target,
		});
		assert.equal(
			f.git([
				"show",
				"-s",
				"--format=%P",
				repo.commitCompletion?.finalHeadSha ?? "HEAD",
			]),
			`${f.D} ${f.B}`,
		);
		assert.equal(f.git(["rev-parse", "HEAD^{tree}"]), f.T);
	} finally {
		f.repo.dispose();
	}
});
