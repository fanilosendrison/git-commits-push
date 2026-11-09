import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { stateSchema } from "../../src/config/state-schema.ts";
import { runDiscovery } from "../../src/modules/core/discovery.ts";
import { assertCommitCompletion } from "../../src/modules/git/commit-completion.ts";
import { publishExplicitTargetSnapshot } from "../../src/modules/git/explicit-push.ts";
import { establishPreparedMergeCommit } from "../../src/modules/git/prepared-merge-publisher.ts";
import { executeMultiCommitAndPush } from "../../src/modules/git/publisher.ts";
import { parseInvocationArguments } from "../../src/modules/invocation/invocation-scope.ts";
import { classifyPublicInvocationMode } from "../../src/modules/reconciliation/classify-public-invocation.ts";
import {
	assertTreeOracle,
	preparedMergeFixture,
} from "../fixtures/prepared-merge.ts";
import { CREATE_SETTINGS, git } from "../fixtures/targeted-create.ts";

const plan = {
	commit: { type: "feat", description: "preserve merge", isBreaking: false },
	files: ["overlap"],
};

test("nominal: exactly ordered two-parent merge, complete T and one remote ref", async () => {
	const f = preparedMergeFixture();
	try {
		const repo = await f.validated();
		const beforeConfig = f.git(["config", "--local", "--list"]);
		const established = establishPreparedMergeCommit(f.scope, repo);
		const M = f.git(["rev-parse", "HEAD"]);
		assert.equal(f.git(["show", "-s", "--format=%P", M]), `${f.D} ${f.C}`);
		assert.equal(
			f.git(["rev-list", "--first-parent", "--count", `${f.D}..${M}`]),
			"1",
		);
		assertTreeOracle(f, M);
		f.git(["merge-base", "--is-ancestor", f.D, M]);
		f.git(["merge-base", "--is-ancestor", f.C, M]);
		assert.ok(
			repo.explicitPushTargetSnapshot &&
				!("kind" in repo.explicitPushTargetSnapshot),
		);
		assert.equal(
			publishExplicitTargetSnapshot(f.root, repo.explicitPushTargetSnapshot, M)
				.publishedSha,
			M,
		);
		assert.equal(git(f.remote, ["rev-parse", f.scope.pushRef]), M);
		assert.equal(
			git(f.remote, ["for-each-ref", "--format=%(refname)"]),
			f.scope.pushRef,
		);
		assert.equal(f.git(["status", "--porcelain"]), "");
		assert.equal(existsSync(f.gitPath("MERGE_HEAD")), false);
		assert.equal(f.git(["config", "--local", "--list"]), beforeConfig);
		assertCommitCompletion({
			...established,
			status: "SUCCESS",
			publishedSha: M,
		});
		assert.equal(classifyPublicInvocationMode(f.args), "targeted");
		assert.deepEqual(parseInvocationArguments(f.args).request, f.scope);
	} finally {
		f.repo.dispose();
	}
});

test("M02: every missing atomic option, duplicates, equals, valued boolean and creation/resume refuse", () => {
	const f = preparedMergeFixture();
	try {
		for (let i = 0; i < f.args.length; i += i === 6 ? 1 : 2) {
			const args = [...f.args];
			args.splice(i, i === 6 ? 1 : 2);
			assert.throws(() => parseInvocationArguments(args));
		}
		for (const extra of [
			["--resume"],
			["--create-if-absent"],
			["--first-parent", f.D],
		])
			assert.throws(() => parseInvocationArguments([...f.args, ...extra]));
		assert.throws(() =>
			parseInvocationArguments(
				f.args.map((arg) =>
					arg === "--publish-prepared-merge"
						? "--publish-prepared-merge=true"
						: arg,
				),
			),
		);
		assert.throws(() =>
			parseInvocationArguments([
				...f.args.slice(0, 7),
				"true",
				...f.args.slice(7),
			]),
		);
	} finally {
		f.repo.dispose();
	}
});

test("M20: historical modes and generic publisher preserve MERGE_HEAD and index", async () => {
	const f = preparedMergeFixture();
	try {
		const repo = await f.validated();
		assert.ok(repo.validatedSource);
		const merge = f.git(["rev-parse", "MERGE_HEAD"]);
		for (const kind of ["worktree", "targeted", "targeted-create"] as const) {
			const scope =
				kind === "worktree"
					? { kind, repository: f.root }
					: {
							kind,
							repository: f.root,
							pushRemote: "origin",
							pushRef: f.scope.pushRef,
							baseRef: "refs/heads/base",
							baseSha: f.B,
						};
			await assert.rejects(runDiscovery(CREATE_SETTINGS, scope), /explicit/);
		}
		await assert.rejects(
			executeMultiCommitAndPush(
				f.root,
				[plan],
				"",
				CREATE_SETTINGS,
				repo.explicitPushTargetSnapshot,
				{ witness: repo.validatedSource },
			),
			/explicit/,
		);
		assert.equal(f.git(["rev-parse", "MERGE_HEAD"]), merge);
		assert.equal(f.git(["write-tree"]), f.T);
	} finally {
		f.repo.dispose();
	}
});

test("hooks cannot transform merge parents, tree or frozen message", async () => {
	const f = preparedMergeFixture();
	try {
		const hooks = path.join(f.root, ".git", "hostile-hooks");
		mkdirSync(hooks);
		for (const hook of [
			"pre-commit",
			"prepare-commit-msg",
			"commit-msg",
			"post-commit",
		])
			writeFileSync(
				path.join(hooks, hook),
				'#!/bin/sh\necho altered > overlap\ngit add overlap\necho foreign >> "$1"\n',
				{ mode: 0o755 },
			);
		f.git(["config", "core.hooksPath", hooks]);
		const repo = establishPreparedMergeCommit(f.scope, await f.validated());
		assert.ok(repo.commitCompletion);
		assertTreeOracle(f, repo.commitCompletion.finalHeadSha);
		assert.equal(
			f.git(["show", "-s", "--format=%B", "HEAD"]),
			f.scope.mergeMessage,
		);
	} finally {
		f.repo.dispose();
	}
});

test("strict durable state rejects cross-mode witness and split ownership", async () => {
	const f = preparedMergeFixture();
	try {
		const repo = await f.validated();
		assert.ok(
			stateSchema.safeParse({ invocationScope: f.scope, repos: { task: repo } })
				.success,
		);
		assert.equal(
			stateSchema.safeParse({
				invocationScope: { ...f.scope, kind: "targeted" },
				repos: { task: repo },
			}).success,
			false,
		);
		assert.equal(
			stateSchema.safeParse({
				invocationScope: f.scope,
				repos: { task: { ...repo, commits: [plan, plan] } },
			}).success,
			false,
		);
	} finally {
		f.repo.dispose();
	}
});
