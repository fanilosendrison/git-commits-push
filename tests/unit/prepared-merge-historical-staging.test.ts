import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { processRepoValidationAndDiff } from "../../src/modules/core/validators/pre-commit-validators.ts";
import { preparedMergeFixture } from "../fixtures/prepared-merge.ts";
import { CREATE_SETTINGS } from "../fixtures/targeted-create.ts";

test("review F1: merge state appearing during repository tests is preserved before historical staging", async () => {
	const f = preparedMergeFixture();
	try {
		unlinkSync(f.gitPath("MERGE_HEAD"));
		const script = path.join(f.root, ".git", "test-creates-merge.cjs");
		writeFileSync(
			script,
			`require('node:fs').writeFileSync(${JSON.stringify(f.gitPath("MERGE_HEAD"))},${JSON.stringify(`${f.C}\n`)});`,
		);
		f.write(
			".gitmodules",
			'[submodule "resolved-gitlink"]\n\tpath = resolved-gitlink\n\turl = .\n',
		);
		f.write(
			"package.json",
			JSON.stringify({ scripts: { test: `node ${JSON.stringify(script)}` } }),
		);
		f.git(["add", "-A"]);
		const index = readFileSync(f.gitPath("index"));
		await assert.rejects(
			processRepoValidationAndDiff(
				{ id: "task", path: f.root },
				{ ...CREATE_SETTINGS, skipTests: false },
			),
			/MERGE_HEAD/,
		);
		assert.equal(f.git(["rev-parse", "HEAD"]), f.D);
		assert.deepEqual(readFileSync(f.gitPath("index")), index);
		assert.equal(f.git(["rev-parse", "MERGE_HEAD"]), f.C);
	} finally {
		f.repo.dispose();
	}
});
