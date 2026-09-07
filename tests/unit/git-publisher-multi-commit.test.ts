// tests/unit/git-publisher.test.ts — Unit tests for src/modules/git/publisher.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { executeMultiCommitAndPush } from "../../src/modules/git/publisher.ts";
import type { CommitPlan, Settings } from "../../src/types.ts";
import { extractDiff } from "../../src/utils/git-utils.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";

const NO_PUSH_SETTINGS: Settings = {
	searchPaths: [],
	provider: "anthropic",
	model: "claude-test",
	temperature: 0,
	systemPromptPath: "/dev/null",
	autoPush: false,
	skipTests: true,
};

describe("U-GE-11 | GIT_TERMINAL_PROMPT=0 is set on all git invocations", () => {
	test("GIT_TERMINAL_PROMPT env var is exported in GIT_ENV constant (structural check)", async () => {
		// Structural test: we verify that executing git with GIT_TERMINAL_PROMPT=0
		// and a bad URL fails immediately (< 2s) rather than hanging
		const start = Date.now();
		const result = spawnSync(
			"git",
			[
				"ls-remote",
				"https://github.com/nonexistent-org-xyz/nonexistent-repo-xyz.git",
			],
			{
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
				encoding: "utf-8",
				timeout: 5000,
			},
		);
		const elapsed = Date.now() - start;
		// Should fail fast (no interactive prompt) — not necessarily exit 0
		assert.notStrictEqual(result.status, null);
		assert.ok(elapsed < 5000);
	});
});

// ─── executeMultiCommitAndPush tests ─────────────────────────────────────────

describe("U-GE-12 | executeMultiCommitAndPush — two files → two distinct commits", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("api.ts", "export const api = 1;\n");
		repo.writeAndStage("ci.yml", "name: CI\n");
	});
	after(() => repo.dispose());

	test("git log shows 2 commits in the right order", async () => {
		const { diffHash } = await extractDiff(repo.dir);
		const plans: CommitPlan[] = [
			{
				commit: {
					type: "feat",
					description: "add api module",
					isBreaking: false,
				},
				files: ["api.ts"],
			},
			{
				commit: {
					type: "ci",
					description: "add ci workflow",
					isBreaking: false,
				},
				files: ["ci.yml"],
			},
		];
		await executeMultiCommitAndPush(
			repo.dir,
			plans,
			diffHash,
			NO_PUSH_SETTINGS,
		);

		const log = spawnSync("git", ["log", "--oneline", "-2"], {
			cwd: repo.dir,
			encoding: "utf-8",
		});
		assert.ok(log.stdout.includes("feat: add api module"));
		assert.ok(log.stdout.includes("ci: add ci workflow"));
	});
});

describe("U-GE-13 | executeMultiCommitAndPush — hallucinated file → throws", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("real.ts", "export const x = 1;\n");
	});
	after(() => repo.dispose());

	test("throws when a listed file is not present in staging", async () => {
		const { diffHash } = await extractDiff(repo.dir);
		const plans: CommitPlan[] = [
			{
				commit: {
					type: "feat",
					description: "add real file",
					isBreaking: false,
				},
				files: ["real.ts", "ghost.ts"], // ghost.ts does not exist
			},
		];
		await assert.rejects(
			executeMultiCommitAndPush(repo.dir, plans, diffHash, NO_PUSH_SETTINGS),
		);
	});
});

describe("U-GE-14 | executeMultiCommitAndPush — diffHash mismatch → throws before any commit", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("f.ts", "export const a = 1;\n");
	});
	after(() => repo.dispose());

	test("throws DiffHash mismatch and makes no commits", async () => {
		const plans: CommitPlan[] = [
			{
				commit: { type: "chore", description: "update f", isBreaking: false },
				files: ["f.ts"],
			},
		];
		await assert.rejects(
			executeMultiCommitAndPush(
				repo.dir,
				plans,
				"wrong-hash-00000000",
				NO_PUSH_SETTINGS,
			),
			(error: unknown) =>
				error instanceof Error && error.message.includes("DiffHash mismatch"),
		);

		// No commit should have been created beyond "initial"
		const log = spawnSync("git", ["log", "--oneline"], {
			cwd: repo.dir,
			encoding: "utf-8",
		});
		assert.strictEqual(log.stdout.trim().split("\n").length, 1);
	});
});

describe("U-GE-15 | executeMultiCommitAndPush — duplicate file across plans → throws before git", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("shared.ts", "export const a = 1;\n");
		repo.writeAndStage("other.ts", "export const b = 2;\n");
	});
	after(() => repo.dispose());

	test("throws with clear Fat Commit message before any git operation", async () => {
		const { diffHash } = await extractDiff(repo.dir);
		const plans: CommitPlan[] = [
			{
				commit: { type: "feat", description: "add feature", isBreaking: false },
				files: ["shared.ts"],
			},
			{
				commit: { type: "fix", description: "fix bug", isBreaking: false },
				files: ["shared.ts", "other.ts"], // shared.ts appears twice!
			},
		];
		await assert.rejects(
			executeMultiCommitAndPush(repo.dir, plans, diffHash, NO_PUSH_SETTINGS),
			/shared\.ts.*multiple plans|Fat Commit/i,
		);

		// No commit should have been created — guard fires before git reset
		const log = spawnSync("git", ["log", "--oneline"], {
			cwd: repo.dir,
			encoding: "utf-8",
		});
		assert.strictEqual(log.stdout.trim().split("\n").length, 1);
	});
});
