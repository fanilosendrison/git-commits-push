// tests/unit/pre-commit-validators.test.ts — Unit tests for src/modules/pre-commit-validators.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import type { SecretScanner } from "../../src/modules/core/validators/pre-commit-validators.ts";
import {
	processRepoValidationAndDiff,
	runTestCascade,
} from "../../src/modules/core/validators/pre-commit-validators.ts";
import type { RepositoryInfo, Settings } from "../../src/types.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";

const BASE_SETTINGS: Settings = {
	searchPaths: [],
	provider: "anthropic",
	model: "claude-test",
	temperature: 0,
	systemPromptPath: "/dev/null",
	autoPush: false,
	skipTests: true,
};

const CLEAN_SCANNER: SecretScanner = async () => ({
	hasSecrets: false,
	matchCount: 0,
});

// ─── U-VA-01 : extracts diff and generates diffHash ──────────────────────────

describe("U-VA-06b | runTestCascade — STACK_EVAL.yaml is actually read (runner dispatched, not fall-through)", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		// STACK_EVAL.yaml specifies pytest. If read, cascade invokes pytest which
		// is not installed → execSync throws → cascade rejects.
		fs.writeFileSync(
			path.join(repo.dir, "STACK_EVAL.yaml"),
			"decisions:\n  test_runner: pytest\n",
		);
		// A passing TypeScript test file. If STACK_EVAL.yaml is ignored, the
		// cascade falls through to Node test auto-discovery, which passes →
		// cascade resolves. This proves STACK_EVAL.yaml was actually read.
		fs.writeFileSync(
			path.join(repo.dir, "passing.test.ts"),
			`import assert from "node:assert/strict";\nimport test from "node:test";\ntest("pass", () => { assert.strictEqual(1, 1); });\n`,
		);
	});
	after(() => repo.dispose());

	test("STACK_EVAL.yaml's pytest runner is dispatched (cascades rejects)", async () => {
		// If STACK_EVAL.yaml was read and pytest was dispatched, pytest is not
		// installed → execSync throws → cascade rejects.
		// If STACK_EVAL.yaml was ignored, cascade runs the passing Node test
		// file and resolves.
		await assert.rejects(runTestCascade(repo.dir));
	});
});

// ─── U-VA-07 : auto-discovers Node tests; historical labels retained ───────

describe("U-VA-07 | runTestCascade — fallback to bun test for *.test.ts files", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		// Write a passing test file — no STACK_EVAL.yaml, no package.json
		fs.writeFileSync(
			path.join(repo.dir, "passing.test.ts"),
			`import assert from "node:assert/strict";\nimport test from "node:test";\ntest("pass", () => { assert.strictEqual(1, 1); });\n`,
		);
	});
	after(() => repo.dispose());

	test("resolves when auto-discovered bun test passes", async () => {
		await assert.strictEqual(await runTestCascade(repo.dir), undefined);
	});
});

// U-VA-07b proves the successor runner is actually invoked, not silently
// skipped. The historical test and suite labels retain their Bun wording for
// mechanical parity attribution.
describe("U-VA-07b | runTestCascade — auto-discovered bun test is actually invoked on failing tests", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		// Failing test, no STACK_EVAL.yaml, no package.json → falls through to
		// auto-discovery (Node test runner on *.test.ts files).
		fs.writeFileSync(
			path.join(repo.dir, "failing.test.ts"),
			`import assert from "node:assert/strict";\nimport test from "node:test";\ntest("fail", () => { assert.strictEqual(true, false); });\n`,
		);
	});
	after(() => repo.dispose());

	test("auto-discovered bun test runs and rejects on a failing test", async () => {
		await assert.rejects(runTestCascade(repo.dir));
	});
});

describe("U-VA-07c | runTestCascade — explicit package manager", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		fs.writeFileSync(path.join(repo.dir, "bun.lock"), "");
		fs.writeFileSync(
			path.join(repo.dir, "package.json"),
			JSON.stringify({
				packageManager: "pnpm@11.24.0",
				scripts: {
					test: "node -e \"if (!process.env.npm_config_user_agent?.startsWith('pnpm/')) process.exit(9)\"",
				},
			}),
		);
	});
	after(() => repo.dispose());

	test("prefers an explicit pnpm declaration when a Bun lock is also present", async () => {
		await assert.strictEqual(await runTestCascade(repo.dir), undefined);
	});
});

describe("U-VA-07d | runTestCascade — package test failures", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		fs.writeFileSync(
			path.join(repo.dir, "package.json"),
			JSON.stringify({
				packageManager: "pnpm@11.24.0",
				scripts: { test: 'node -e "process.exit(7)"' },
			}),
		);
	});
	after(() => repo.dispose());

	test("propagates a declared package test failure", async () => {
		await assert.rejects(runTestCascade(repo.dir));
	});
});

// ─── U-VA-08 : no-op when no tests found ─────────────────────────────────────

describe("U-VA-08 | runTestCascade — silent when no test runner detected", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		// No test files, no STACK_EVAL.yaml, no package.json
	});
	after(() => repo.dispose());

	test("resolves without error when no test runner is found", async () => {
		await assert.strictEqual(await runTestCascade(repo.dir), undefined);
	});
});

// ─── U-VA-09 : diffHash is deterministic ─────────────────────────────────────

describe("U-VA-09 | diffHash is deterministic for the same diff content", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("det.ts", "export const det = 'deterministic';\n");
	});
	after(() => repo.dispose());

	test("two calls on the same staged diff produce the same diffHash", async () => {
		const repoInfo: RepositoryInfo = { id: "test-id", path: repo.dir };
		const result1 = await processRepoValidationAndDiff(
			repoInfo,
			BASE_SETTINGS,
			CLEAN_SCANNER,
		);
		// Re-stage the exact same content (git add -A is idempotent on same content)
		const result2 = await processRepoValidationAndDiff(
			repoInfo,
			BASE_SETTINGS,
			CLEAN_SCANNER,
		);
		assert.strictEqual(result1.diffHash, result2.diffHash);
	});
});
