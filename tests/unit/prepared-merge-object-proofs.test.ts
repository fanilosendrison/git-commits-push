import assert from "node:assert/strict";
import { test } from "node:test";
import { establishPreparedMergeCommit } from "../../src/modules/git/prepared-merge-publisher.ts";
import { assertPreparedMergeCommit } from "../../src/modules/git/prepared-merge-source.ts";
import { preparedMergeFixture } from "../fixtures/prepared-merge.ts";
import { git } from "../fixtures/targeted-create.ts";

for (const wrong of ["tree", "reversed", "single", "octopus", "message"])
	test(`M17/M18: actual ${wrong} object is independently rejected`, async () => {
		const f = preparedMergeFixture();
		try {
			const repo = await f.validated();
			const witness = repo.validatedSource;
			assert.ok(witness);
			const parents =
				wrong === "reversed"
					? [f.C, f.D]
					: wrong === "single"
						? [f.D]
						: wrong === "octopus"
							? [f.D, f.C, f.B]
							: [f.D, f.C];
			const tree =
				wrong === "tree" ? f.git(["rev-parse", `${f.D}^{tree}`]) : f.T;
			const M = f.git([
				"commit-tree",
				tree,
				...parents.flatMap((sha) => ["-p", sha]),
				"-m",
				wrong === "message" ? "feat: foreign message" : f.scope.mergeMessage,
			]);
			assert.throws(() => assertPreparedMergeCommit(f.root, M, witness));
			f.git(["update-ref", "HEAD", M, f.D]);
			assert.throws(() => establishPreparedMergeCommit(f.scope, repo));
			assert.equal(f.git(["rev-parse", "HEAD"]), M);
			assert.equal(git(f.remote, ["rev-parse", f.scope.pushRef]), f.D);
		} finally {
			f.repo.dispose();
		}
	});
