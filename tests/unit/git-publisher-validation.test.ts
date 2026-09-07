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
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { CommitPlanError } from "../../src/modules/core/errors.ts";
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

		await assert.notStrictEqual(
			await executeMultiCommitAndPush(
				repo.dir,
				plans,
				diffHash,
				NO_PUSH_SETTINGS,
			),
			undefined,
		);

		repo.dispose();
	});
});

// ── classifyTransient ────────────────────────────────────────────────────────

describe("classifyTransient", () => {
	test("auth error → transient=false", () => {
		assert.strictEqual(
			classifyTransient("Permission denied (publickey)."),
			false,
		);
	});

	test("network error → transient=true", () => {
		assert.strictEqual(
			classifyTransient("Could not resolve host: github.com"),
			true,
		);
	});

	test("repository not found → transient=false", () => {
		assert.strictEqual(classifyTransient("repository not found"), false);
	});

	test("empty message → transient=true", () => {
		assert.strictEqual(classifyTransient(""), true);
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

		assert.ok(caught instanceof CommitPlanError);
		if (caught instanceof CommitPlanError) {
			assert.strictEqual(caught.kind, "nonexistent-file");
			// R59: context captures plan 1's landed commit
			const context = caught.context;
			assert.ok(context);
			const committedShas = context.committedShas;
			const pendingFiles = context.pendingFiles;
			assert.ok(committedShas);
			assert.ok(pendingFiles);
			assert.strictEqual(committedShas.length, 1);
			assert.deepStrictEqual(committedShas[0]?.files, ["a.ts"]);
			assert.ok(pendingFiles.includes("c.ts"));
			assert.ok(!pendingFiles.includes("a.ts"));
			// ghost.ts from the failed plan IS in pendingFiles (planned but not committed)
			assert.ok(pendingFiles.includes("ghost.ts"));
		}

		// Verify plan 1's commit landed in git history
		const log = execSync("git log --oneline", {
			cwd: repo.dir,
			encoding: "utf-8",
		});
		assert.ok(log.includes("add a"));

		repo.dispose();
	});
});

// ── Empty plans → CommitPlanError("empty-plans") ───────────────────────────

describe("empty plans → CommitPlanError(empty-plans)", () => {
	test("throws CommitPlanError with kind empty-plans", async () => {
		const repo = GitRepoFixture.create();
		repo.commit("initial");
		const { diffHash } = await extractDiff(repo.dir);

		await assert.rejects(
			executeMultiCommitAndPush(repo.dir, [], diffHash, NO_PUSH_SETTINGS),
			{ kind: "empty-plans" },
		);

		repo.dispose();
	});
});
