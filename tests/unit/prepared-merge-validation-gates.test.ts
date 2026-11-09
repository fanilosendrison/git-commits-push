import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { validatePreparedMerge } from "../../src/modules/git/prepared-merge-validation.ts";
import { preparedMergeFixture } from "../fixtures/prepared-merge.ts";
import { CREATE_SETTINGS, git } from "../fixtures/targeted-create.ts";

for (const location of ["second-parent", "resolved-tree"] as const)
	test(`secret scanning rejects ${location} input despite ambient masking`, async () => {
		const bytes = `const apiKey = "sk-${"A".repeat(48)}";\n`;
		const f = preparedMergeFixture(
			location === "second-parent"
				? { candidateBytes: bytes }
				: { resolutionBytes: bytes },
		);
		try {
			writeFileSync(
				path.join(f.root, ".git", "info", "attributes"),
				"* diff=mask\n",
			);
			f.git(["config", "diff.mask.textconv", "printf harmless"]);
			await assert.rejects(
				validatePreparedMerge(f.scope, CREATE_SETTINGS),
				/Secret detected/,
			);
			assert.equal(f.git(["rev-parse", "HEAD"]), f.D);
			assert.equal(f.git(["write-tree"]), f.T);
			assert.equal(f.git(["rev-parse", "MERGE_HEAD"]), f.C);
			assert.equal(git(f.remote, ["rev-parse", f.scope.pushRef]), f.D);
		} finally {
			f.repo.dispose();
		}
	});

test("asynchronous validation cannot ratify a moved MERGE_HEAD", async () => {
	const f = preparedMergeFixture();
	let calls = 0;
	try {
		await assert.rejects(
			validatePreparedMerge(f.scope, CREATE_SETTINGS, async () => {
				calls++;
				if (calls === 1) writeFileSync(f.gitPath("MERGE_HEAD"), `${f.B}\n`);
				return { hasSecrets: false, matchCount: 0 };
			}),
			/MERGE_HEAD changed/,
		);
		assert.equal(calls, 2);
		assert.equal(f.git(["rev-parse", "HEAD"]), f.D);
		assert.equal(git(f.remote, ["rev-parse", f.scope.pushRef]), f.D);
	} finally {
		f.repo.dispose();
	}
});
