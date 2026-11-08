import assert from "node:assert/strict";
import path from "node:path";
import { establishPreparedMergeCommit } from "../../src/modules/git/prepared-merge-publisher.ts";
import { preparedMergeFixture } from "./prepared-merge.ts";
import { git } from "./targeted-create.ts";

/** Independent mutations of each frozen admission operand; no publication is attempted. */
export async function frozenAuthorityCase(mutation: string): Promise<void> {
	const f = preparedMergeFixture();
	try {
		let repo = await f.validated();
		const witness = repo.validatedSource;
		assert.ok(witness);
		if (mutation === "M08" || mutation === "M14") {
			f.write("overlap", "foreign bytes\n");
			f.git(["add", "overlap"]);
		}
		if (mutation === "M09" || mutation === "M19")
			f.commit("test: foreign local commit");
		if (mutation === "M11")
			repo = {
				...repo,
				validatedSource: {
					...witness,
					expectedChangedPaths: witness.expectedChangedPaths.slice(1),
				},
			};
		if (mutation === "M12")
			repo = {
				...repo,
				validatedSource: {
					...witness,
					expectedChangedPaths: [...witness.expectedChangedPaths, "overlap"],
				},
			};
		const plan = {
			commit: {
				type: "feat",
				description: "preserve merge",
				isBreaking: false,
			},
			files: ["overlap"],
		};
		if (mutation === "M13") repo = { ...repo, commits: [plan, plan] };
		if (mutation === "M15") {
			// Competing fixture state needs C's actual objects before its bare-ref update.
			f.git(["update-ref", "refs/fixture/candidate", f.C]);
			git(f.remote, ["fetch", "--no-tags", f.root, "refs/fixture/candidate"]);
			git(f.remote, ["update-ref", f.scope.pushRef, f.C, f.D]);
		}
		if (mutation === "M16")
			f.git([
				"remote",
				"set-url",
				"origin",
				path.join(f.root, ".git", "foreign.git"),
			]);
		const head = f.git(["rev-parse", "HEAD"]);
		const index = f.git(["write-tree"]);
		assert.throws(() => establishPreparedMergeCommit(f.scope, repo));
		assert.equal(f.git(["rev-parse", "HEAD"]), head);
		assert.equal(f.git(["write-tree"]), index);
		assert.equal(
			git(f.remote, ["rev-parse", f.scope.pushRef]),
			mutation === "M15" ? f.C : f.D,
		);
	} finally {
		f.repo.dispose();
	}
}
