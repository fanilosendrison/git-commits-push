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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CommitPlanError,
	DiffHashMismatchError,
} from "../../src/modules/core/errors.ts";
import { executeMultiCommitAndPush } from "../../src/modules/git/publisher.ts";
import { classifyTransient } from "../../src/modules/git/push.ts";
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

		expect(result.committedShas).toHaveLength(2);
		expect(result.committedShas[0]?.files).toEqual(["a.ts"]);
		expect(result.committedShas[1]?.files).toEqual(["b.ts"]);
		expect(result.originalHead).toBeTruthy();
		expect(typeof result.originalHead).toBe("string");

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
		expect(headShow).toBe("y.ts");

		const prevShow = spawnSync(
			"git",
			["show", "--name-only", "--format=", "HEAD~1"],
			{
				cwd: repo.dir,
				encoding: "utf-8",
			},
		).stdout.trim();
		expect(prevShow).toBe("x.ts");

		repo.dispose();
	});
});

// ── U-GE-18: DiffHash mismatch → DiffHashMismatchError ──────────────────────

describe("U-GE-18 | diffHash mismatch → DiffHashMismatchError", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("f.ts", "export const a = 1;\n");
	});
	afterAll(() => repo.dispose());

	test("throws DiffHashMismatchError and makes no commits", async () => {
		const plans: CommitPlan[] = [
			{
				commit: { type: "chore", description: "update f", isBreaking: false },
				files: ["f.ts"],
			},
		];

		await expect(
			executeMultiCommitAndPush(
				repo.dir,
				plans,
				"wrong-hash",
				NO_PUSH_SETTINGS,
			),
		).rejects.toThrow(DiffHashMismatchError);

		const log = spawnSync("git", ["log", "--oneline"], {
			cwd: repo.dir,
			encoding: "utf-8",
		});
		expect(log.stdout.trim().split("\n").length).toBe(1);
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

		await expect(
			executeMultiCommitAndPush(repo.dir, plans, diffHash, NO_PUSH_SETTINGS),
		).rejects.toMatchObject({ kind: "missing-file" });

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

		await expect(
			executeMultiCommitAndPush(repo.dir, plans, diffHash, NO_PUSH_SETTINGS),
		).rejects.toMatchObject({ kind: "nonexistent-file" });

		repo.dispose();
	});
});

// ── U-GE-15v2: duplicate file → CommitPlanError(kind: "duplicate-file") ─────

describe("U-GE-15v2 | duplicate file → CommitPlanError(kind: duplicate-file)", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("shared.ts", "export const a = 1;\n");
		repo.writeAndStage("other.ts", "export const b = 2;\n");
	});
	afterAll(() => repo.dispose());

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

		await expect(
			executeMultiCommitAndPush(repo.dir, plans, diffHash, NO_PUSH_SETTINGS),
		).rejects.toMatchObject({ kind: "duplicate-file" });
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

		await expect(
			executeMultiCommitAndPush(repo.dir, plans, diffHash, NO_PUSH_SETTINGS),
		).rejects.toMatchObject({ kind: "duplicate-file" });

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

		await expect(
			executeMultiCommitAndPush(repo.dir, plans, diffHash, NO_PUSH_SETTINGS),
		).rejects.toMatchObject({ kind: "duplicate-file" });

		repo.dispose();
	});
});

describe("U-GE-44 | case-insensitive FS tolerant", () => {
	// On case-insensitive filesystems (macOS APFS default), two files differing
	// only in case are the SAME file.
	const isCaseSensitive = (() => {
		try {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "case-test-"));
			fs.writeFileSync(path.join(tmpDir, "probe"), "a");
			fs.writeFileSync(path.join(tmpDir, "PROBE"), "b");
			const content = fs.readFileSync(path.join(tmpDir, "probe"), "utf-8");
			fs.rmSync(tmpDir, { recursive: true, force: true });
			return content === "a";
		} catch {
			return false;
		}
	})();

	test("CamelCase.ts and camelcase.ts are NOT flagged as duplicates", async () => {
		if (!isCaseSensitive) {
			return; // skip on case-insensitive FS
		}

		const repo = GitRepoFixture.create();
		repo.commit("initial");

		fs.mkdirSync(path.join(repo.dir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(repo.dir, "src", "CamelCase.ts"),
			"export const a = 1;\n",
		);
		fs.writeFileSync(
			path.join(repo.dir, "src", "camelcase.ts"),
			"export const b = 2;\n",
		);
		execSync("git add -A", { cwd: repo.dir, encoding: "utf-8" });

		const { diffHash } = await extractDiff(repo.dir);
		const plans: CommitPlan[] = [
			{
				commit: { type: "feat", description: "first", isBreaking: false },
				files: ["src/CamelCase.ts"],
			},
			{
				commit: { type: "feat", description: "second", isBreaking: false },
				files: ["src/camelcase.ts"],
			},
		];

		await expect(
			executeMultiCommitAndPush(repo.dir, plans, diffHash, NO_PUSH_SETTINGS),
		).resolves.toBeDefined();

		repo.dispose();
	});
});

// ── classifyTransient ────────────────────────────────────────────────────────

describe("classifyTransient", () => {
	test("auth error → transient=false", () => {
		expect(classifyTransient("Permission denied (publickey).")).toBe(false);
	});

	test("network error → transient=true", () => {
		expect(classifyTransient("Could not resolve host: github.com")).toBe(true);
	});

	test("repository not found → transient=false", () => {
		expect(classifyTransient("repository not found")).toBe(false);
	});

	test("empty message → transient=true", () => {
		expect(classifyTransient("")).toBe(true);
	});
});

// ── U-GE-16: Mid-loop failure with context.committedShas (R59) ───────────

describe("U-GE-16 | mid-loop failure preserves committed SHAs in context", () => {
	test("plan 1 commits, plan 2 ghost file → context carries landed SHA", async () => {
		const repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("a.ts", "export const a = 1;\n");
		repo.writeAndStage("c.ts", "export const c = 1;\n");

		const { diffHash } = await extractDiff(repo.dir);
		const plans: CommitPlan[] = [
			{
				commit: { type: "feat", description: "add a", isBreaking: false },
				files: ["a.ts"],
			},
			{
				commit: { type: "feat", description: "add b", isBreaking: false },
				files: ["ghost.ts"], // doesn't exist → nonexistent-file at index 1
			},
			{
				commit: { type: "feat", description: "add c", isBreaking: false },
				files: ["c.ts"],
			},
		];

		let caught: unknown;
		try {
			await executeMultiCommitAndPush(
				repo.dir,
				plans,
				diffHash,
				NO_PUSH_SETTINGS,
			);
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(CommitPlanError);
		if (caught instanceof CommitPlanError) {
			expect(caught.kind).toBe("nonexistent-file");
			// R59: context captures plan 1's landed commit
			expect(caught.context?.committedShas).toHaveLength(1);
			expect(caught.context?.committedShas?.[0]?.files).toEqual(["a.ts"]);
			expect(caught.context?.pendingFiles).toContain("c.ts");
			expect(caught.context?.pendingFiles).not.toContain("a.ts");
			// ghost.ts from the failed plan IS in pendingFiles (planned but not committed)
			expect(caught.context?.pendingFiles).toContain("ghost.ts");
		}

		// Verify plan 1's commit landed in git history
		const log = execSync("git log --oneline", {
			cwd: repo.dir,
			encoding: "utf-8",
		});
		expect(log).toContain("add a");

		repo.dispose();
	});
});

// ── Empty plans → CommitPlanError("empty-plans") ───────────────────────────

describe("empty plans → CommitPlanError(empty-plans)", () => {
	test("throws CommitPlanError with kind empty-plans", async () => {
		const repo = GitRepoFixture.create();
		repo.commit("initial");
		const { diffHash } = await extractDiff(repo.dir);

		await expect(
			executeMultiCommitAndPush(repo.dir, [], diffHash, NO_PUSH_SETTINGS),
		).rejects.toMatchObject({ kind: "empty-plans" });

		repo.dispose();
	});
});
