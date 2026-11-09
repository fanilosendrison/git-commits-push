import assert from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { validatePreparedMerge } from "../../src/modules/git/prepared-merge-validation.ts";
import { preparedMergeFixture } from "../fixtures/prepared-merge.ts";
import { CREATE_SETTINGS, git } from "../fixtures/targeted-create.ts";

for (const mutation of [
	"M01",
	"M03",
	"M04",
	"M05",
	"M06",
	"M07",
	"M10",
] as const)
	test(`${mutation}: invalid prepared state refuses before commit and remote effects`, async () => {
		const f = preparedMergeFixture();
		try {
			let scope = f.scope;
			if (mutation === "M01") unlinkSync(f.gitPath("MERGE_HEAD"));
			if (mutation === "M03") scope = { ...scope, firstParent: f.B };
			if (mutation === "M04") scope = { ...scope, secondParent: f.B };
			if (mutation === "M05")
				writeFileSync(f.gitPath("MERGE_HEAD"), `${f.C}\n${f.B}\n`);
			if (mutation === "M06")
				scope = { ...scope, firstParent: f.C, secondParent: f.D };
			if (mutation === "M07")
				writeFileSync(f.gitPath("index"), f.conflictedIndex);
			if (mutation === "M10")
				scope = { ...scope, secondParent: "f".repeat(40) };
			const index = f.git(["ls-files", "--stage", "-z"]);
			await assert.rejects(validatePreparedMerge(scope, CREATE_SETTINGS));
			assert.equal(f.git(["rev-parse", "HEAD"]), f.D);
			assert.equal(f.git(["ls-files", "--stage", "-z"]), index);
			assert.equal(git(f.remote, ["rev-parse", f.scope.pushRef]), f.D);
		} finally {
			f.repo.dispose();
		}
	});
