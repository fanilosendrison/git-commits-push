import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PostCommitPushError } from "../../src/modules/core/errors.ts";
import { processRepoValidationAndDiff } from "../../src/modules/core/validators/pre-commit-validators.ts";
import { executeMultiCommitAndPush } from "../../src/modules/git/publisher.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import {
	CREATE_SETTINGS,
	createFixture,
	git,
} from "../fixtures/targeted-create.ts";

for (const mutation of ["changed-missing", "unchanged-materialized"] as const)
	test(`NEGATIVE_05: skip-worktree cannot hide ${mutation} source drift`, async () => {
		const repo = GitRepoFixture.create();
		try {
			repo.writeAndStage("a.ts", "base\n");
			repo.writeAndStage("b.ts", "base\n");
			repo.commit("base");
			repo.writeAndStage("a.ts", "validated\n");
			const v = await processRepoValidationAndDiff(
				{ id: "task", path: repo.dir },
				CREATE_SETTINGS,
			);
			const file = mutation === "changed-missing" ? "a.ts" : "b.ts";
			git(repo.dir, ["update-index", "--skip-worktree", "--", file]);
			if (mutation === "changed-missing") unlinkSync(path.join(repo.dir, file));
			else writeFileSync(path.join(repo.dir, file), "unvalidated\n");
			const before = readFileSync(path.join(repo.dir, ".git", "index"));
			await assert.rejects(
				executeMultiCommitAndPush(
					repo.dir,
					[
						{
							commit: {
								type: "test",
								description: "reject hidden source drift",
								isBreaking: false,
							},
							files: ["a.ts"],
						},
					],
					v.diffHash,
					CREATE_SETTINGS,
					undefined,
					{ witness: v.validatedSource },
				),
				/Worktree changed/,
			);
			assert.deepEqual(
				readFileSync(path.join(repo.dir, ".git", "index")),
				before,
			);
		} finally {
			repo.dispose();
		}
	});

for (const mode of ["split-index", "sparse-checkout"] as const)
	test(`historical ${mode} preserves unchanged Git content while completing T`, async () => {
		const repo = GitRepoFixture.create();
		try {
			mkdirSync(path.join(repo.dir, "visible"));
			mkdirSync(path.join(repo.dir, "hidden"));
			repo.writeAndStage("visible/a.ts", "original\n");
			repo.writeAndStage("hidden/b.ts", "retained\n");
			repo.commit("base");
			if (mode === "split-index")
				git(repo.dir, ["update-index", "--split-index"]);
			else {
				git(repo.dir, ["config", "core.sparseCheckout", "true"]);
				writeFileSync(
					path.join(repo.dir, ".git", "info", "sparse-checkout"),
					"/visible/\n",
				);
				git(repo.dir, ["read-tree", "-mu", "HEAD"]);
			}
			repo.writeAndStage("visible/a.ts", "validated change\n");
			const v = await processRepoValidationAndDiff(
				{ id: "task", path: repo.dir },
				CREATE_SETTINGS,
			);
			await executeMultiCommitAndPush(
				repo.dir,
				[
					{
						commit: {
							type: "test",
							description: "preserve index compatibility",
							isBreaking: false,
						},
						files: ["visible/a.ts"],
					},
				],
				v.diffHash,
				CREATE_SETTINGS,
				undefined,
				{ witness: v.validatedSource },
			);
			assert.equal(
				git(repo.dir, ["rev-parse", "HEAD^{tree}"]),
				v.validatedSource.expectedTreeSha,
			);
			assert.equal(git(repo.dir, ["show", "HEAD:hidden/b.ts"]), "retained");
		} finally {
			repo.dispose();
		}
	});

test("NEGATIVE_05/09: raced index bytes and foreign-worktree witnesses are preserved and refused", async () => {
	const repo = GitRepoFixture.create();
	try {
		repo.commit("base");
		repo.writeAndStage("a.ts", "validated\n");
		const v = await processRepoValidationAndDiff(
			{ id: "task", path: repo.dir },
			CREATE_SETTINGS,
		);
		repo.writeAndStage("a.ts", "raced\n");
		const index = path.join(repo.dir, ".git", "index");
		const before = readFileSync(index);
		const plans = [
			{
				commit: {
					type: "test",
					description: "retain source authority",
					isBreaking: false,
				},
				files: ["a.ts"],
			},
		];
		await assert.rejects(
			executeMultiCommitAndPush(
				repo.dir,
				plans,
				v.diffHash,
				CREATE_SETTINGS,
				undefined,
				{ witness: v.validatedSource },
			),
			/Index changed/,
		);
		assert.deepEqual(readFileSync(index), before);
		await assert.rejects(
			executeMultiCommitAndPush(
				repo.dir,
				plans,
				v.diffHash,
				CREATE_SETTINGS,
				undefined,
				{
					witness: {
						...v.validatedSource,
						gitDirectory: path.join(repo.dir, "foreign"),
					},
				},
			),
			/different worktree/,
		);
		assert.deepEqual(readFileSync(index), before);
	} finally {
		repo.dispose();
	}
});

test("POSITIVE_09: an authorized submodule is one gitlink, never its child paths", async () => {
	const parent = GitRepoFixture.create();
	const source = GitRepoFixture.create();
	try {
		source.commit("child base");
		parent.commit("parent base");
		git(parent.dir, [
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			source.dir,
			"child",
		]);
		parent.commit("record child");
		const child = path.join(parent.dir, "child");
		git(child, ["config", "user.name", "Fixture"]);
		git(child, ["config", "user.email", "fixture@example.invalid"]);
		writeFileSync(path.join(child, "child.ts"), "child change\n");
		git(child, ["add", "-A"]);
		git(child, ["commit", "--no-verify", "-m", "test: update child"]);
		const childHead = git(child, ["rev-parse", "HEAD"]);
		git(parent.dir, ["config", "diff.ignoreSubmodules", "all"]);
		parent.writeAndStage("parent.ts", "parent change\n");
		git(parent.dir, ["add", "--", "child"]);
		assert.match(
			git(parent.dir, ["ls-files", "--stage", "--", "child"]),
			new RegExp(childHead),
		);
		const v = await processRepoValidationAndDiff(
			{ id: "parent", path: parent.dir },
			CREATE_SETTINGS,
		);
		assert.deepEqual(v.validatedSource.expectedChangedPaths, [
			"child",
			"parent.ts",
		]);
		const before = git(parent.dir, ["rev-parse", "HEAD"]);
		await assert.rejects(
			executeMultiCommitAndPush(
				parent.dir,
				[
					{
						commit: {
							type: "test",
							description: "omit hidden gitlink",
							isBreaking: false,
						},
						files: ["parent.ts"],
					},
				],
				v.diffHash,
				CREATE_SETTINGS,
				undefined,
				{ witness: v.validatedSource },
			),
			{ kind: "incomplete-coverage" },
		);
		assert.equal(git(parent.dir, ["rev-parse", "HEAD"]), before);
		await executeMultiCommitAndPush(
			parent.dir,
			[
				{
					commit: {
						type: "test",
						description: "record authorized gitlink",
						isBreaking: false,
					},
					files: ["child", "parent.ts"],
				},
			],
			v.diffHash,
			CREATE_SETTINGS,
			undefined,
			{ witness: v.validatedSource },
		);
		assert.equal(
			git(parent.dir, ["rev-parse", "HEAD^{tree}"]),
			v.validatedSource.expectedTreeSha,
		);
		assert.equal(
			git(parent.dir, ["ls-tree", "HEAD", "--", "child"]),
			`160000 commit ${childHead}\tchild`,
		);
		assert.equal(git(child, ["rev-parse", "HEAD"]), childHead);
	} finally {
		parent.dispose();
		source.dispose();
	}
});

test("NEGATIVE_05: publication pins the proven SHA even when HEAD advances after final-tree verification", async () => {
	const f = createFixture();
	const originalPath = process.env.PATH;
	try {
		const branch = git(f.repo.dir, [
			"for-each-ref",
			"--format=%(refname:short)",
			"refs/heads",
		]);
		git(f.repo.dir, ["checkout", "--quiet", branch]);
		git(f.repo.dir, ["branch", "--set-upstream-to=origin/source", branch]);
		git(f.repo.dir, ["config", "push.default", "upstream"]);
		f.repo.writeAndStage("a.ts", "validated\n");
		const settings = { ...CREATE_SETTINGS, autoPush: true };
		const v = await processRepoValidationAndDiff(
			{ id: "task", path: f.repo.dir },
			settings,
		);
		const hooks = path.join(f.repo.dir, ".git", "hooks");
		git(f.repo.dir, ["config", "core.hooksPath", hooks]);
		const marker = path.join(f.repo.dir, ".git", "commit-landed");
		writeFileSync(
			path.join(hooks, "post-commit"),
			`#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`,
		);
		chmodSync(path.join(hooks, "post-commit"), 0o755);
		const bin = path.join(f.repo.dir, ".git", "race-bin");
		mkdirSync(bin);
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const wrapper = path.join(bin, "git");
		writeFileSync(
			wrapper,
			`#!/bin/sh\nif [ "$1" = remote ] && [ -f ${JSON.stringify(marker)} ]; then\n rm ${JSON.stringify(marker)}\n printf 'foreign\\n' > foreign.txt\n ${JSON.stringify(realGit)} add -- foreign.txt\n ${JSON.stringify(realGit)} commit --no-verify -qm 'test: foreign history'\n rm ${JSON.stringify(marker)}\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
		);
		chmodSync(wrapper, 0o755);
		process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
		let failure: unknown;
		try {
			await executeMultiCommitAndPush(
				f.repo.dir,
				[
					{
						commit: {
							type: "test",
							description: "publish proven source",
							isBreaking: false,
						},
						files: ["a.ts"],
					},
				],
				v.diffHash,
				settings,
				undefined,
				{ witness: v.validatedSource },
			);
		} catch (error) {
			failure = error;
		}
		assert.ok(failure instanceof PostCommitPushError);
		assert.equal(
			failure.context.committedShas[0]?.sha,
			git(f.repo.dir, ["rev-parse", "HEAD~1"]),
		);
		assert.equal(git(f.remote, ["rev-parse", "refs/heads/source"]), f.baseSha);
		assert.notEqual(
			git(f.repo.dir, ["rev-parse", "HEAD^{tree}"]),
			v.validatedSource.expectedTreeSha,
		);
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		f.repo.dispose();
	}
});

test("literal newline, tab, quotes and leading whitespace remain exact Git path identities", async () => {
	const repo = GitRepoFixture.create();
	try {
		repo.commit("base");
		const files = [
			"line\nbreak.ts",
			"tab\tname.ts",
			'quote"name.ts',
			" leading.ts",
		];
		for (const file of files)
			writeFileSync(path.join(repo.dir, file), "safe content\n");
		const v = await processRepoValidationAndDiff(
			{ id: "task", path: repo.dir },
			CREATE_SETTINGS,
		);
		assert.deepEqual(
			new Set(v.validatedSource.expectedChangedPaths),
			new Set(files),
		);
		await executeMultiCommitAndPush(
			repo.dir,
			[
				{
					commit: {
						type: "test",
						description: "preserve literal path bytes",
						isBreaking: false,
					},
					files,
				},
			],
			v.diffHash,
			CREATE_SETTINGS,
			undefined,
			{ witness: v.validatedSource },
		);
		assert.equal(
			git(repo.dir, ["rev-parse", "HEAD^{tree}"]),
			v.validatedSource.expectedTreeSha,
		);
	} finally {
		repo.dispose();
	}
});
