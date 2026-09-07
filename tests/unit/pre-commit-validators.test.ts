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
