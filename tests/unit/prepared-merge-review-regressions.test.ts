import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { processRepoValidationAndDiff } from "../../src/modules/core/validators/pre-commit-validators.ts";
import { assertCommitCompletion } from "../../src/modules/git/commit-completion.ts";
import { publishExplicitTargetSnapshot } from "../../src/modules/git/explicit-push.ts";
import {
	establishPreparedMergeCommit,
	publishEstablishedPreparedMerge,
} from "../../src/modules/git/prepared-merge-publisher.ts";
import { validatePreparedMerge } from "../../src/modules/git/prepared-merge-validation.ts";
import { preparedMergeFixture } from "../fixtures/prepared-merge.ts";
import { CREATE_SETTINGS, git } from "../fixtures/targeted-create.ts";

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

test("review F3: source movement during remote observation refuses before the first send", async () => {
	const f = preparedMergeFixture();
	const oldPath = process.env.PATH;
	try {
		const repo = establishPreparedMergeCommit(f.scope, await f.validated());
		const bin = path.join(f.root, ".git", "remote-race-bin");
		mkdirSync(bin);
		const actual = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		writeFileSync(
			path.join(bin, "git"),
			`#!/bin/sh\nif [ "$1" = ls-remote ]; then ${JSON.stringify(actual)} "$@"; result=$?; echo foreign > ${JSON.stringify(path.join(f.root, "overlap"))}; exit "$result"; fi\nexec ${JSON.stringify(actual)} "$@"\n`,
			{ mode: 0o755 },
		);
		process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ""}`;
		assert.throws(
			() => publishEstablishedPreparedMerge(f.scope, repo),
			/changed|Worktree/,
		);
		assert.equal(
			git(f.remote, ["rev-parse", f.scope.pushRef]),
			f.D,
			"changed input must be refused before any publication",
		);
	} finally {
		if (oldPath === undefined) delete process.env.PATH;
		else process.env.PATH = oldPath;
		f.repo.dispose();
	}
});

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
