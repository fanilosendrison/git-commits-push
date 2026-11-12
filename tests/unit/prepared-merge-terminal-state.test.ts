import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { assertCommitCompletion } from "../../src/modules/git/commit-completion.ts";
import { publishExplicitTargetSnapshot } from "../../src/modules/git/explicit-push.ts";
import { establishPreparedMergeCommit } from "../../src/modules/git/prepared-merge-publisher.ts";
import { preparedMergeFixture } from "../fixtures/prepared-merge.ts";
import { git } from "../fixtures/targeted-create.ts";

test("review F4: active merge state invalidates terminal success after exact publication", async () => {
	const f = preparedMergeFixture();
	try {
		const repo = establishPreparedMergeCommit(f.scope, await f.validated());
		const M = repo.commitCompletion?.finalHeadSha;
		assert.ok(M);
		const target = repo.explicitPushTargetSnapshot;
		assert.ok(target && !("kind" in target));
		publishExplicitTargetSnapshot(f.root, target, M);
		writeFileSync(f.gitPath("MERGE_HEAD"), `${f.C}\n`);
		assert.throws(
			() =>
				assertCommitCompletion({ ...repo, status: "SUCCESS", publishedSha: M }),
			/MERGE_HEAD|merge state/,
		);
		assert.equal(git(f.remote, ["rev-parse", f.scope.pushRef]), M);
	} finally {
		f.repo.dispose();
	}
});
