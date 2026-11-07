import assert from "node:assert/strict";
import {
	mkdirSync,
	renameSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { stateSchema } from "../../src/config/state-schema.ts";
import { classifyError } from "../../src/modules/core/error-classifier.ts";
import { CommitPlanError } from "../../src/modules/core/errors.ts";
import { processRepoValidationAndDiff } from "../../src/modules/core/validators/pre-commit-validators.ts";
import { assertCommitCompletion } from "../../src/modules/git/commit-completion.ts";
import { executeMultiCommitAndPush } from "../../src/modules/git/publisher.ts";
import {
	assertFinalTree,
	assertValidatedSource,
} from "../../src/modules/git/validated-source.ts";
import type { CommitPlan } from "../../src/types.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import {
	CREATE_SETTINGS,
	createFixture,
	git,
} from "../fixtures/targeted-create.ts";

const plan = (files: string[]): CommitPlan => ({
	commit: {
		type: "test",
		description: "qualify complete publication",
		isBreaking: false,
	},
	files,
});

for (const omitted of [1, 5])
	test(`NEGATIVE_0${omitted === 1 ? 1 : 2}: omitted ${omitted} paths rejects before any effect`, async () => {
		const f = createFixture();
		try {
			mkdirSync(path.join(f.repo.dir, "tests"));
			const files = [
				"a.ts",
				"b.ts",
				...Array.from({ length: 5 }, (_, i) => `tests/case-${i}.ts`),
			];
			for (const file of files)
				writeFileSync(path.join(f.repo.dir, file), "safe fixture\n");
			const validation = await processRepoValidationAndDiff(
				{ id: "task", path: f.repo.dir },
				CREATE_SETTINGS,
			);
			const before = git(f.repo.dir, ["write-tree"]);
			await assert.rejects(
				executeMultiCommitAndPush(
					f.repo.dir,
					[plan(files.slice(0, 7 - omitted))],
					validation.diffHash,
					CREATE_SETTINGS,
					undefined,
					{ witness: validation.validatedSource },
				),
				{ kind: "incomplete-coverage" },
			);
			assert.equal(git(f.repo.dir, ["rev-parse", "HEAD"]), f.baseSha);
			assert.equal(git(f.repo.dir, ["write-tree"]), before);
			assert.equal(
				git(f.remote, [
					"for-each-ref",
					"--format=%(objectname)",
					"refs/heads/task",
				]),
				"",
			);
		} finally {
			f.repo.dispose();
		}
	});

for (const mutation of [
	"index",
	"worktree",
	"untracked",
	"head",
	"missing-witness",
] as const)
	test(`NEGATIVE_05/09: ${mutation} cannot replace validated authority`, async () => {
		const repo = GitRepoFixture.create();
		try {
			repo.commit("base");
			repo.writeAndStage("a.ts", "validated\n");
			const validation = await processRepoValidationAndDiff(
				{ id: "task", path: repo.dir },
				CREATE_SETTINGS,
			);
			if (mutation === "index") repo.writeAndStage("a.ts", "raced\n");
			if (mutation === "worktree")
				writeFileSync(path.join(repo.dir, "a.ts"), "raced\n");
			if (mutation === "untracked")
				writeFileSync(path.join(repo.dir, "foreign.ts"), "unvalidated\n");
			if (mutation === "head") repo.commit("concurrent");
			const head = git(repo.dir, ["rev-parse", "HEAD"]);
			const index = git(repo.dir, ["write-tree"]);
			await assert.rejects(
				executeMultiCommitAndPush(
					repo.dir,
					[plan(["a.ts"])],
					validation.diffHash,
					CREATE_SETTINGS,
					undefined,
					mutation === "missing-witness"
						? undefined
						: { witness: validation.validatedSource },
				),
				/witness|changed|uncheckpointed/i,
			);
			assert.equal(git(repo.dir, ["rev-parse", "HEAD"]), head);
			assert.equal(git(repo.dir, ["write-tree"]), index);
		} finally {
			repo.dispose();
		}
	});

test("NEGATIVE_06: duplicate literal path and directory cannot conceal an omission", async () => {
	const repo = GitRepoFixture.create();
	try {
		repo.commit("base");
		mkdirSync(path.join(repo.dir, "tests"));
		repo.writeAndStage("tests/a.ts", "a\n");
		repo.writeAndStage("tests/b.ts", "b\n");
		const v = await processRepoValidationAndDiff(
			{ id: "task", path: repo.dir },
			CREATE_SETTINGS,
		);
		for (const [plans, kind] of [
			[
				[plan(["tests/a.ts"]), plan(["tests/a.ts", "tests/b.ts"])],
				"duplicate-file",
			],
			[[plan(["tests"])], "incomplete-coverage"],
		] as const)
			await assert.rejects(
				executeMultiCommitAndPush(
					repo.dir,
					[...plans],
					v.diffHash,
					CREATE_SETTINGS,
					undefined,
					{ witness: v.validatedSource },
				),
				{ kind },
			);
	} finally {
		repo.dispose();
	}
});

for (const split of [false, true])
	test(`POSITIVE_01/02/07: ${split ? "multi" : "single"} commit reaches T without fabricating push`, async () => {
		const repo = GitRepoFixture.create();
		try {
			repo.commit("base");
			repo.writeAndStage("a.ts", "a\n");
			repo.writeAndStage("b.ts", "b\n");
			const v = await processRepoValidationAndDiff(
				{ id: "task", path: repo.dir },
				CREATE_SETTINGS,
			);
			const r = await executeMultiCommitAndPush(
				repo.dir,
				split ? [plan(["a.ts"]), plan(["b.ts"])] : [plan(["a.ts", "b.ts"])],
				v.diffHash,
				CREATE_SETTINGS,
				undefined,
				{ witness: v.validatedSource },
			);
			assert.equal(
				git(repo.dir, ["rev-parse", "HEAD^{tree}"]),
				v.validatedSource.expectedTreeSha,
			);
			assert.equal(r.publishedSha, null);
			assert.equal(r.committedShas.length, split ? 2 : 1);
			assertCommitCompletion({
				repository: repo.dir,
				status: "SUCCESS",
				operation: "commit-and-push",
				validatedSource: v.validatedSource,
				committedShas: r.committedShas,
				commitCompletion: {
					finalHeadSha: git(repo.dir, ["rev-parse", "HEAD"]),
					finalTreeSha: v.validatedSource.expectedTreeSha,
				},
			});
		} finally {
			repo.dispose();
		}
	});

test("POSITIVE_03: structural retry remains bound to the same durable tree", async () => {
	const repo = GitRepoFixture.create();
	try {
		repo.commit("base");
		repo.writeAndStage("a.ts", "a\n");
		repo.writeAndStage("b.ts", "b\n");
		const v = await processRepoValidationAndDiff(
			{ id: "task", path: repo.dir },
			CREATE_SETTINGS,
		);
		const state = stateSchema.parse({
			invocationScope: { kind: "worktree", repository: repo.dir },
			repos: {
				task: {
					repository: repo.dir,
					status: "RUNNING",
					operation: "commit-and-push",
					validatedSource: v.validatedSource,
				},
			},
		});
		const witness = state.repos.task?.validatedSource;
		assert.ok(witness);
		await assert.rejects(
			executeMultiCommitAndPush(
				repo.dir,
				[plan(["a.ts"])],
				v.diffHash,
				CREATE_SETTINGS,
				undefined,
				{ witness },
			),
			{ kind: "incomplete-coverage" },
		);
		await executeMultiCommitAndPush(
			repo.dir,
			[plan(["a.ts", "b.ts"])],
			v.diffHash,
			CREATE_SETTINGS,
			undefined,
			{ witness },
		);
		assert.equal(
			git(repo.dir, ["rev-parse", "HEAD^{tree}"]),
			witness.expectedTreeSha,
		);
	} finally {
		repo.dispose();
	}
});

test("POSITIVE_04 and NEGATIVE_03/10: actual partial chain can complete, but empty plan/remote SHA cannot prove completeness", async () => {
	const f = createFixture();
	try {
		f.repo.writeAndStage("a.ts", "a\n");
		f.repo.writeAndStage("b.ts", "b\n");
		const v = await processRepoValidationAndDiff(
			{ id: "task", path: f.repo.dir },
			CREATE_SETTINGS,
		);
		git(f.repo.dir, ["reset", "--mixed"]);
		git(f.repo.dir, ["add", "a.ts"]);
		git(f.repo.dir, ["commit", "--no-verify", "-m", "test: first part"]);
		const sha = git(f.repo.dir, ["rev-parse", "HEAD"]);
		const committedShas = [{ sha, files: ["a.ts"] }];
		assert.deepEqual(
			assertValidatedSource(f.repo.dir, v.validatedSource, committedShas)
				.remainingPaths,
			["b.ts"],
		);
		assert.throws(
			() => assertFinalTree(f.repo.dir, v.validatedSource),
			/Final tree completeness/,
		);
		assert.throws(
			() =>
				assertCommitCompletion({
					repository: f.repo.dir,
					status: "SUCCESS",
					validatedSource: v.validatedSource,
					committedShas,
					publishedSha: sha,
				}),
			/proof|complet/i,
		);
		await assert.rejects(
			executeMultiCommitAndPush(
				f.repo.dir,
				[],
				v.diffHash,
				CREATE_SETTINGS,
				undefined,
				{ witness: v.validatedSource, committedShas },
			),
			{ kind: "empty-plans" },
		);
		assert.equal(
			classifyError(new CommitPlanError("empty", "empty-plans"), true).kind,
			"retry",
		);
		await executeMultiCommitAndPush(
			f.repo.dir,
			[plan(["b.ts"])],
			v.diffHash,
			CREATE_SETTINGS,
			undefined,
			{ witness: v.validatedSource, committedShas },
		);
		assert.equal(git(f.repo.dir, ["rev-parse", "HEAD~1"]), sha);
		assert.equal(
			assertFinalTree(f.repo.dir, v.validatedSource),
			v.validatedSource.expectedTreeSha,
		);
	} finally {
		f.repo.dispose();
	}
});

test("NEGATIVE_07/08 and POSITIVE_08: literal metacharacters, rename, deletion and symlink membership", async () => {
	const repo = GitRepoFixture.create();
	try {
		repo.writeAndStage("old.txt", "old\n");
		repo.writeAndStage("deleted.txt", "delete\n");
		repo.commit("base");
		renameSync(
			path.join(repo.dir, "old.txt"),
			path.join(repo.dir, "new name.txt"),
		);
		unlinkSync(path.join(repo.dir, "deleted.txt"));
		for (const file of ["[literal].ts", ":(glob)*.ts", "space name.ts"])
			writeFileSync(path.join(repo.dir, file), "literal\n");
		symlinkSync("new name.txt", path.join(repo.dir, "link"));
		const v = await processRepoValidationAndDiff(
			{ id: "task", path: repo.dir },
			CREATE_SETTINGS,
		);
		assert.deepEqual(
			new Set(v.validatedSource.expectedChangedPaths),
			new Set([
				"old.txt",
				"new name.txt",
				"deleted.txt",
				"[literal].ts",
				":(glob)*.ts",
				"space name.ts",
				"link",
			]),
		);
		await executeMultiCommitAndPush(
			repo.dir,
			[plan([...v.validatedSource.expectedChangedPaths])],
			v.diffHash,
			CREATE_SETTINGS,
			undefined,
			{ witness: v.validatedSource },
		);
		assert.equal(
			assertFinalTree(repo.dir, v.validatedSource),
			v.validatedSource.expectedTreeSha,
		);
	} finally {
		repo.dispose();
	}
});

test("POSITIVE: unborn validated HEAD remains null", async () => {
	const repo = GitRepoFixture.create();
	try {
		repo.writeAndStage("first.ts", "first\n");
		const v = await processRepoValidationAndDiff(
			{ id: "task", path: repo.dir },
			CREATE_SETTINGS,
		);
		assert.equal(v.validatedSource.baseHeadSha, null);
		await executeMultiCommitAndPush(
			repo.dir,
			[plan(["first.ts"])],
			v.diffHash,
			CREATE_SETTINGS,
			undefined,
			{ witness: v.validatedSource },
		);
		assert.equal(
			assertFinalTree(repo.dir, v.validatedSource),
			v.validatedSource.expectedTreeSha,
		);
	} finally {
		repo.dispose();
	}
});
