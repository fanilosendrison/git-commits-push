/**
 * tests/unit/git-publisher-v2.test.ts — Phase 3 publisher refactor tests.
 *
 * Tests for the new executeMultiCommitAndPush v2 API:
 *   - Return type { committedShas, originalHead }
 *   - Typed errors (CommitPlanError, DiffHashMismatchError, PartialCommitError, PushError)
 *   - Path normalization (R56)
 *   - Inter-commit isolation (C1)
 *
 * Plan reference: §7.1 Publisher tests (U-GE-15 through U-GE-25, U-GE-42–U-GE-45)
 */

import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { DiffHashMismatchError } from "../../src/modules/core/errors.ts";
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

// ── U-GE-17: All commits succeed → return { committedShas, originalHead } ────

describe("U-GE-17 | all commits succeed → return committedShas", () => {
	test("returns committedShas with 2 entries and originalHead", async () => {
		const repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("a.ts", "export const a = 1;\n");
		repo.writeAndStage("b.ts", "export const b = 2;\n");

		const { diffHash } = await extractDiff(repo.dir);
		const plans: CommitPlan[] = [
			{
				commit: { type: "feat", description: "add a", isBreaking: false },
				files: ["a.ts"],
			},
			{
				commit: { type: "feat", description: "add b", isBreaking: false },
				files: ["b.ts"],
			},
		];

		const result = await executeMultiCommitAndPush(
			repo.dir,
			plans,
			diffHash,
			NO_PUSH_SETTINGS,
		);

		assert.strictEqual(result.committedShas.length, 2);
		assert.deepStrictEqual(result.committedShas[0]?.files, ["a.ts"]);
		assert.deepStrictEqual(result.committedShas[1]?.files, ["b.ts"]);
		assert.ok(result.originalHead);
		assert.strictEqual(typeof result.originalHead, "string");

		repo.dispose();
	});

	test("each commit contains ONLY its own files (C1 isolation)", async () => {
		const repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("x.ts", "export const x = 1;\n");
		repo.writeAndStage("y.ts", "export const y = 2;\n");

		const { diffHash } = await extractDiff(repo.dir);
		const plans: CommitPlan[] = [
			{
				commit: { type: "feat", description: "add x", isBreaking: false },
				files: ["x.ts"],
			},
			{
				commit: { type: "feat", description: "add y", isBreaking: false },
				files: ["y.ts"],
			},
		];

		await executeMultiCommitAndPush(
			repo.dir,
			plans,
			diffHash,
			NO_PUSH_SETTINGS,
		);

		const headShow = spawnSync(
			"git",
			["show", "--name-only", "--format=", "HEAD"],
			{
				cwd: repo.dir,
				encoding: "utf-8",
			},
		).stdout.trim();
		assert.strictEqual(headShow, "y.ts");

		const prevShow = spawnSync(
			"git",
			["show", "--name-only", "--format=", "HEAD~1"],
			{
				cwd: repo.dir,
				encoding: "utf-8",
			},
		).stdout.trim();
		assert.strictEqual(prevShow, "x.ts");

		repo.dispose();
	});
});

// ── U-GE-18: DiffHash mismatch → DiffHashMismatchError ──────────────────────

describe("U-GE-18 | diffHash mismatch → DiffHashMismatchError", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("f.ts", "export const a = 1;\n");
	});
	after(() => repo.dispose());

	test("throws DiffHashMismatchError and makes no commits", async () => {
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
				"wrong-hash",
				NO_PUSH_SETTINGS,
			),
			DiffHashMismatchError,
		);

		const log = spawnSync("git", ["log", "--oneline"], {
			cwd: repo.dir,
			encoding: "utf-8",
		});
		assert.strictEqual(log.stdout.trim().split("\n").length, 1);
	});
});

// ── U-GE-19: missing-file (no changes to commit) ────────────────────────────

describe("U-GE-19 | missing-file → CommitPlanError", () => {
	test("plan referencing only an already-committed file throws missing-file", async () => {
		const repo = GitRepoFixture.create();
		repo.commit("initial");

		repo.writeAndStage("unchanged.ts", "export const u = 1;\n");
		repo.commit("commit unchanged");

		repo.writeAndStage("new.ts", "export const n = 1;\n");
		const { diffHash } = await extractDiff(repo.dir);

		const plans: CommitPlan[] = [
			{
				commit: {
					type: "feat",
					description: "change unchanged",
					isBreaking: false,
				},
				files: ["unchanged.ts"],
			},
		];

		await assert.rejects(
			executeMultiCommitAndPush(repo.dir, plans, diffHash, NO_PUSH_SETTINGS),
			{ kind: "missing-file" },
		);

		repo.dispose();
	});

	test("plan mixing changed and unchanged files still commits the change", async () => {
		const repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("unchanged.ts", "export const u = 1;\n");
		repo.commit("commit unchanged");
		repo.writeAndStage("changed.ts", "export const c = 1;\n");
		const { diffHash } = await extractDiff(repo.dir);

		const result = await executeMultiCommitAndPush(
			repo.dir,
			[
				{
					commit: {
						type: "feat",
						description: "add changed file",
						isBreaking: false,
					},
					files: ["changed.ts", "unchanged.ts"],
				},
			],
			diffHash,
			NO_PUSH_SETTINGS,
		);

		assert.strictEqual(result.committedShas.length, 1);
		assert.match(
			execSync("git show --name-only --format= HEAD", {
				cwd: repo.dir,
				encoding: "utf-8",
			}),
			/changed\.ts/u,
		);
		repo.dispose();
	});
});

// ── U-GE-22: nonexistent-file ───────────────────────────────────────────────

describe("U-GE-22 | nonexistent-file → CommitPlanError", () => {
	test("plan referencing a non-existent file throws nonexistent-file", async () => {
		const repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("real.ts", "export const r = 1;\n");

		const { diffHash } = await extractDiff(repo.dir);
		const plans: CommitPlan[] = [
			{
				commit: { type: "feat", description: "add real", isBreaking: false },
				files: ["real.ts", "ghost.ts"],
			},
		];

		await assert.rejects(
			executeMultiCommitAndPush(repo.dir, plans, diffHash, NO_PUSH_SETTINGS),
			{ kind: "nonexistent-file" },
		);

		repo.dispose();
	});
});

// ── U-GE-15v2: duplicate file → CommitPlanError(kind: "duplicate-file") ─────

describe("U-GE-15v2 | duplicate file → CommitPlanError(kind: duplicate-file)", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("shared.ts", "export const a = 1;\n");
		repo.writeAndStage("other.ts", "export const b = 2;\n");
	});
	after(() => repo.dispose());

	test("throws CommitPlanError with kind duplicate-file", async () => {
		const { diffHash } = await extractDiff(repo.dir);
		const plans: CommitPlan[] = [
			{
				commit: { type: "feat", description: "add feature", isBreaking: false },
				files: ["shared.ts"],
			},
			{
				commit: { type: "fix", description: "fix bug", isBreaking: false },
				files: ["shared.ts", "other.ts"],
			},
		];

		await assert.rejects(
			executeMultiCommitAndPush(repo.dir, plans, diffHash, NO_PUSH_SETTINGS),
			{ kind: "duplicate-file" },
		);
	});
});

// ── U-GE-42: Path normalization (R56) ───────────────────────────────────────

describe("U-GE-42 | path normalization catches src/./foo.ts vs src/foo.ts", () => {
	test("src/./foo.ts and src/foo.ts are detected as duplicate", async () => {
		const repo = GitRepoFixture.create();
		repo.commit("initial");

		fs.mkdirSync(path.join(repo.dir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(repo.dir, "src", "foo.ts"),
			"export const a = 1;\n",
		);
		fs.writeFileSync(
			path.join(repo.dir, "src", "bar.ts"),
			"export const b = 2;\n",
		);
		execSync("git add -A", { cwd: repo.dir, encoding: "utf-8" });

		const { diffHash } = await extractDiff(repo.dir);
		const plans: CommitPlan[] = [
			{
				commit: { type: "feat", description: "first", isBreaking: false },
				files: ["src/foo.ts"],
			},
			{
				commit: { type: "feat", description: "second", isBreaking: false },
				files: ["src/./foo.ts", "src/bar.ts"],
			},
		];

		await assert.rejects(
			executeMultiCommitAndPush(repo.dir, plans, diffHash, NO_PUSH_SETTINGS),
			{ kind: "duplicate-file" },
		);

		repo.dispose();
	});
});

describe("U-GE-43 | path normalization catches trailing slash", () => {
	test("src/foo.ts/ normalizes to src/foo.ts → duplicate detected", async () => {
		const repo = GitRepoFixture.create();
		repo.commit("initial");

		fs.mkdirSync(path.join(repo.dir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(repo.dir, "src", "foo.ts"),
			"export const a = 1;\n",
		);
		fs.writeFileSync(
			path.join(repo.dir, "src", "bar.ts"),
			"export const b = 2;\n",
		);
		execSync("git add -A", { cwd: repo.dir, encoding: "utf-8" });

		const { diffHash } = await extractDiff(repo.dir);
		const plans: CommitPlan[] = [
			{
				commit: { type: "feat", description: "first", isBreaking: false },
				files: ["src/foo.ts"],
			},
			{
				commit: { type: "feat", description: "second", isBreaking: false },
				files: ["src/foo.ts/", "src/bar.ts"],
			},
		];

		await assert.rejects(
			executeMultiCommitAndPush(repo.dir, plans, diffHash, NO_PUSH_SETTINGS),
			{ kind: "duplicate-file" },
		);

		repo.dispose();
	});
});
