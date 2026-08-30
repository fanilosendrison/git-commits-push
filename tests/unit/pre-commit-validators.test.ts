// tests/unit/pre-commit-validators.test.ts — Unit tests for src/modules/pre-commit-validators.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
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
const SECRET_SCANNER: SecretScanner = async () => ({
	hasSecrets: true,
	details: "Found: AWS_KEY",
	matchCount: 1,
});
const WARNING_SCANNER: SecretScanner = async () => ({
	hasSecrets: false,
	matchCount: 0,
	warningCount: 1,
	warningDetails: "Generic API Key at line 12",
});
const THROWING_SCANNER: SecretScanner = async () => {
	throw new Error("Scanner internal error");
};

// ─── U-VA-01 : extracts diff and generates diffHash ──────────────────────────

describe("U-VA-01 | processRepoValidationAndDiff — extracts diff and SHA-256 diffHash", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("a.ts", "export const a = 1;\n");
	});
	after(() => repo.dispose());

	test("returns diff string and hex SHA-256 diffHash", async () => {
		const repoInfo: RepositoryInfo = { id: "test-id", path: repo.dir };
		const result = await processRepoValidationAndDiff(
			repoInfo,
			BASE_SETTINGS,
			CLEAN_SCANNER,
		);
		assert.ok(result.diff.includes("+export const a = 1;"));
		assert.match(result.diffHash, /^[a-f0-9]{64}$/);
	});
});

// ─── U-VA-02 : throws on empty diff ──────────────────────────────────────────

describe("U-VA-02 | processRepoValidationAndDiff — throws if nothing staged after git add -A", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		// No changes after commit
	});
	after(() => repo.dispose());

	test("throws 'No changes found after staging'", async () => {
		const repoInfo: RepositoryInfo = { id: "test-id", path: repo.dir };
		await assert.rejects(
			processRepoValidationAndDiff(repoInfo, BASE_SETTINGS, CLEAN_SCANNER),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes("No changes found after staging"),
		);
	});
});

// ─── U-VA-03 : throws when scanner detects secret ────────────────────────────

describe("U-VA-03 | processRepoValidationAndDiff — throws when scanner returns hasSecrets: true", () => {
	let repo: GitRepoFixture;
	let statsDir: string;

	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage(
			"secret.ts",
			`export const key = "AKIAIOSFODNN7EXAMPLE";\n`,
		);
		// Redirect stats to temp dir for test isolation
		statsDir = path.join(os.tmpdir(), `ss-test-${Date.now()}`);
		process.env.SECRET_SCANNER_STATS_DIR = statsDir;
	});
	after(() => {
		repo.dispose();
		delete process.env.SECRET_SCANNER_STATS_DIR;
		if (fs.existsSync(statsDir))
			fs.rmSync(statsDir, { recursive: true, force: true });
	});

	test("throws 'Security Exception' and logs a block event", async () => {
		const repoInfo: RepositoryInfo = { id: "test-id", path: repo.dir };
		await assert.rejects(
			processRepoValidationAndDiff(repoInfo, BASE_SETTINGS, SECRET_SCANNER),
			(error: unknown) =>
				error instanceof Error && error.message.includes("Security Exception"),
		);

		// Verify stats were logged
		const eventsPath = path.join(statsDir, "events.jsonl");
		assert.strictEqual(fs.existsSync(eventsPath), true);
		const events = fs
			.readFileSync(eventsPath, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].eventType, "block");
		assert.strictEqual(events[0].namespace, "secret-scanner");
		assert.strictEqual(events[0].details.findingsCount, 1);
		assert.strictEqual(events[0].details.findings[0].name, "Found: AWS_KEY");
	});
});

// ─── U-VA-03b : logs passed event when scanner detects no secrets ─────────────

describe("U-VA-03b | processRepoValidationAndDiff — logs passed event when scanner returns hasSecrets: false", () => {
	let repo: GitRepoFixture;
	let statsDir: string;

	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("safe.ts", "export const x = 1;\n");
		statsDir = path.join(os.tmpdir(), `ss-pass-test-${Date.now()}`);
		process.env.SECRET_SCANNER_STATS_DIR = statsDir;
	});
	after(() => {
		repo.dispose();
		delete process.env.SECRET_SCANNER_STATS_DIR;
		if (fs.existsSync(statsDir))
			fs.rmSync(statsDir, { recursive: true, force: true });
	});

	test("logs a passed event", async () => {
		const repoInfo: RepositoryInfo = { id: "test-id", path: repo.dir };
		await processRepoValidationAndDiff(repoInfo, BASE_SETTINGS, CLEAN_SCANNER);

		const eventsPath = path.join(statsDir, "events.jsonl");
		assert.strictEqual(fs.existsSync(eventsPath), true);
		const events = fs
			.readFileSync(eventsPath, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].eventType, "passed");
		assert.strictEqual(events[0].namespace, "secret-scanner");
		assert.strictEqual(events[0].details.findingsCount, 0);
	});
});

// ─── U-VA-03c : logs warning event for tolerated scanner matches ─────────────

describe("U-VA-03c | processRepoValidationAndDiff — logs warning event without blocking", () => {
	let repo: GitRepoFixture;
	let statsDir: string;

	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("safe.ts", "export const x = 1;\n");
		statsDir = path.join(os.tmpdir(), `ss-warning-test-${Date.now()}`);
		process.env.SECRET_SCANNER_STATS_DIR = statsDir;
	});
	after(() => {
		repo.dispose();
		delete process.env.SECRET_SCANNER_STATS_DIR;
		if (fs.existsSync(statsDir))
			fs.rmSync(statsDir, { recursive: true, force: true });
	});

	test("resolves and logs a warning event", async () => {
		const repoInfo: RepositoryInfo = { id: "test-id", path: repo.dir };
		const result = await processRepoValidationAndDiff(
			repoInfo,
			BASE_SETTINGS,
			WARNING_SCANNER,
		);
		assert.match(result.diffHash, /^[a-f0-9]{64}$/);

		const eventsPath = path.join(statsDir, "events.jsonl");
		assert.strictEqual(fs.existsSync(eventsPath), true);
		const events = fs
			.readFileSync(eventsPath, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].eventType, "warning");
		assert.strictEqual(events[0].namespace, "secret-scanner");
		assert.strictEqual(events[0].details.findingsCount, 1);
		assert.strictEqual(events[0].details.findings[0].name, "Generic API Key");
	});
});

// ─── U-VA-04 : fail-closed when scanner throws ───────────────────────────────

describe("U-VA-04 | processRepoValidationAndDiff — fail-closed when scanner throws", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("safe.ts", "export const x = 1;\n");
	});
	after(() => repo.dispose());

	test("propagates scanner exception (fail-closed per DC-SECRET-SCANNER §3)", async () => {
		const repoInfo: RepositoryInfo = { id: "test-id", path: repo.dir };
		await assert.rejects(
			processRepoValidationAndDiff(repoInfo, BASE_SETTINGS, THROWING_SCANNER),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes("Scanner internal error"),
		);
	});
});

// ─── U-VA-05 : skipTests bypasses test cascade ───────────────────────────────

describe("U-VA-05 | processRepoValidationAndDiff — skipTests: true bypasses test runner", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		// Write a FAILING test file — if runTestCascade runs, this test will throw
		fs.writeFileSync(
			path.join(repo.dir, "failing.test.ts"),
			`import assert from "node:assert/strict";\nimport test from "node:test";\ntest("fail", () => { assert.strictEqual(true, false); });\n`,
		);
		repo.writeAndStage("change.ts", "export const y = 2;\n");
	});
	after(() => repo.dispose());

	test("resolves successfully even with a failing test file when skipTests: true", async () => {
		const repoInfo: RepositoryInfo = { id: "test-id", path: repo.dir };
		const result = await processRepoValidationAndDiff(
			repoInfo,
			{ ...BASE_SETTINGS, skipTests: true },
			CLEAN_SCANNER,
		);
		assert.match(result.diffHash, /^[a-f0-9]{64}$/);
	});
});

// ─── U-VA-06 : STACK_EVAL.yaml test runner detection ────────────────────────

describe("U-VA-06 | runTestCascade — detects STACK_EVAL.yaml and uses declared runner", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		// Write a STACK_EVAL.yaml that says 'none' — safe to run in test environment
		fs.writeFileSync(
			path.join(repo.dir, "STACK_EVAL.yaml"),
			"decisions:\n  test_runner: none\n",
		);
	});
	after(() => repo.dispose());

	test("resolves without error when STACK_EVAL.yaml declares test_runner: none", async () => {
		await assert.strictEqual(await runTestCascade(repo.dir), undefined);
	});
});

// U-VA-06b: proves STACK_EVAL.yaml is ACTUALLY read (not silently ignored).
// A buggy implementation that ignored STACK_EVAL.yaml would fall through to
// auto-discovery and run `bun test` on the *.test.ts file — which PASSES.
// A correct implementation reads STACK_EVAL.yaml, matches the `pytest` case,
// and execSync("pytest", ...) — which FAILS (pytest is not installed in the
// bun test environment). The two outcomes differ:
//   - STACK_EVAL.yaml read → cascade rejects (pytest not found)
//   - STACK_EVAL.yaml ignored → cascade resolves (bun test passes)
// Requires pytest NOT to be installed (true for this project's test env).
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
