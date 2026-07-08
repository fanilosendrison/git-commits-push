// tests/unit/pre-commit-validators.test.ts — Unit tests for src/modules/pre-commit-validators.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
const THROWING_SCANNER: SecretScanner = async () => {
	throw new Error("Scanner internal error");
};

// ─── U-VA-01 : extracts diff and generates diffHash ──────────────────────────

describe("U-VA-01 | processRepoValidationAndDiff — extracts diff and SHA-256 diffHash", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("a.ts", "export const a = 1;\n");
	});
	afterAll(() => repo.dispose());

	test("returns diff string and hex SHA-256 diffHash", async () => {
		const repoInfo: RepositoryInfo = { id: "test-id", path: repo.dir };
		const result = await processRepoValidationAndDiff(
			repoInfo,
			BASE_SETTINGS,
			CLEAN_SCANNER,
		);
		expect(result.diff).toContain("+export const a = 1;");
		expect(result.diffHash).toMatch(/^[a-f0-9]{64}$/);
	});
});

// ─── U-VA-02 : throws on empty diff ──────────────────────────────────────────

describe("U-VA-02 | processRepoValidationAndDiff — throws if nothing staged after git add -A", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		// No changes after commit
	});
	afterAll(() => repo.dispose());

	test("throws 'No changes found after staging'", async () => {
		const repoInfo: RepositoryInfo = { id: "test-id", path: repo.dir };
		await expect(
			processRepoValidationAndDiff(repoInfo, BASE_SETTINGS, CLEAN_SCANNER),
		).rejects.toThrow("No changes found after staging");
	});
});

// ─── U-VA-03 : throws when scanner detects secret ────────────────────────────

describe("U-VA-03 | processRepoValidationAndDiff — throws when scanner returns hasSecrets: true", () => {
	let repo: GitRepoFixture;
	let statsDir: string;

	beforeAll(() => {
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
	afterAll(() => {
		repo.dispose();
		delete process.env.SECRET_SCANNER_STATS_DIR;
		if (fs.existsSync(statsDir))
			fs.rmSync(statsDir, { recursive: true, force: true });
	});

	test("throws 'Security Exception' and logs a block event", async () => {
		const repoInfo: RepositoryInfo = { id: "test-id", path: repo.dir };
		await expect(
			processRepoValidationAndDiff(repoInfo, BASE_SETTINGS, SECRET_SCANNER),
		).rejects.toThrow("Security Exception");

		// Verify stats were logged
		const eventsPath = path.join(statsDir, "events.jsonl");
		expect(fs.existsSync(eventsPath)).toBe(true);
		const events = fs
			.readFileSync(eventsPath, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		expect(events.length).toBe(1);
		expect(events[0].eventType).toBe("block");
		expect(events[0].namespace).toBe("secret-scanner");
		expect(events[0].details.findingsCount).toBe(1);
		expect(events[0].details.findings[0].name).toBe("Found: AWS_KEY");
	});
});

// ─── U-VA-03b : logs passed event when scanner detects no secrets ─────────────

describe("U-VA-03b | processRepoValidationAndDiff — logs passed event when scanner returns hasSecrets: false", () => {
	let repo: GitRepoFixture;
	let statsDir: string;

	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("safe.ts", "export const x = 1;\n");
		statsDir = path.join(os.tmpdir(), `ss-pass-test-${Date.now()}`);
		process.env.SECRET_SCANNER_STATS_DIR = statsDir;
	});
	afterAll(() => {
		repo.dispose();
		delete process.env.SECRET_SCANNER_STATS_DIR;
		if (fs.existsSync(statsDir))
			fs.rmSync(statsDir, { recursive: true, force: true });
	});

	test("logs a passed event", async () => {
		const repoInfo: RepositoryInfo = { id: "test-id", path: repo.dir };
		await processRepoValidationAndDiff(repoInfo, BASE_SETTINGS, CLEAN_SCANNER);

		const eventsPath = path.join(statsDir, "events.jsonl");
		expect(fs.existsSync(eventsPath)).toBe(true);
		const events = fs
			.readFileSync(eventsPath, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		expect(events.length).toBe(1);
		expect(events[0].eventType).toBe("passed");
		expect(events[0].namespace).toBe("secret-scanner");
		expect(events[0].details.findingsCount).toBe(0);
	});
});

// ─── U-VA-04 : fail-closed when scanner throws ───────────────────────────────

describe("U-VA-04 | processRepoValidationAndDiff — fail-closed when scanner throws", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("safe.ts", "export const x = 1;\n");
	});
	afterAll(() => repo.dispose());

	test("propagates scanner exception (fail-closed per DC-SECRET-SCANNER §3)", async () => {
		const repoInfo: RepositoryInfo = { id: "test-id", path: repo.dir };
		await expect(
			processRepoValidationAndDiff(repoInfo, BASE_SETTINGS, THROWING_SCANNER),
		).rejects.toThrow("Scanner internal error");
	});
});

// ─── U-VA-05 : skipTests bypasses test cascade ───────────────────────────────

describe("U-VA-05 | processRepoValidationAndDiff — skipTests: true bypasses test runner", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		// Write a FAILING test file — if runTestCascade runs, this test will throw
		fs.writeFileSync(
			path.join(repo.dir, "failing.test.ts"),
			`import { expect, test } from "bun:test";\ntest("fail", () => { expect(true).toBe(false); });\n`,
		);
		repo.writeAndStage("change.ts", "export const y = 2;\n");
	});
	afterAll(() => repo.dispose());

	test("resolves successfully even with a failing test file when skipTests: true", async () => {
		const repoInfo: RepositoryInfo = { id: "test-id", path: repo.dir };
		await expect(
			processRepoValidationAndDiff(
				repoInfo,
				{ ...BASE_SETTINGS, skipTests: true },
				CLEAN_SCANNER,
			),
		).resolves.toMatchObject({
			diffHash: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});
});

// ─── U-VA-06 : STACK_EVAL.yaml test runner detection ────────────────────────

describe("U-VA-06 | runTestCascade — detects STACK_EVAL.yaml and uses declared runner", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		// Write a STACK_EVAL.yaml that says 'none' — safe to run in test environment
		fs.writeFileSync(
			path.join(repo.dir, "STACK_EVAL.yaml"),
			"decisions:\n  test_runner: none\n",
		);
	});
	afterAll(() => repo.dispose());

	test("resolves without error when STACK_EVAL.yaml declares test_runner: none", async () => {
		await expect(runTestCascade(repo.dir)).resolves.toBeUndefined();
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
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		// STACK_EVAL.yaml specifies pytest. If read, cascade invokes pytest which
		// is not installed → execSync throws → cascade rejects.
		fs.writeFileSync(
			path.join(repo.dir, "STACK_EVAL.yaml"),
			"decisions:\n  test_runner: pytest\n",
		);
		// A passing TypeScript test file. If STACK_EVAL.yaml is ignored, the
		// cascade falls through to auto-discovery (bun test) which passes →
		// cascade resolves. This proves STACK_EVAL.yaml was actually read.
		fs.writeFileSync(
			path.join(repo.dir, "passing.test.ts"),
			`import { expect, test } from "bun:test";\ntest("pass", () => { expect(1).toBe(1); });\n`,
		);
	});
	afterAll(() => repo.dispose());

	test("STACK_EVAL.yaml's pytest runner is dispatched (cascades rejects)", async () => {
		// If STACK_EVAL.yaml was read and pytest was dispatched, pytest is not
		// installed → execSync throws → cascade rejects.
		// If STACK_EVAL.yaml was ignored, cascade falls through to bun test
		// on the passing test file → resolves.
		await expect(runTestCascade(repo.dir)).rejects.toThrow();
	});
});

// ─── U-VA-07 : auto-discovers bun test for .test.ts files ───────────────────

describe("U-VA-07 | runTestCascade — fallback to bun test for *.test.ts files", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		// Write a passing test file — no STACK_EVAL.yaml, no package.json
		fs.writeFileSync(
			path.join(repo.dir, "passing.test.ts"),
			`import { expect, test } from "bun:test";\ntest("pass", () => { expect(1).toBe(1); });\n`,
		);
	});
	afterAll(() => repo.dispose());

	test("resolves when auto-discovered bun test passes", async () => {
		await expect(runTestCascade(repo.dir)).resolves.toBeUndefined();
	});
});

// U-VA-07b: proves bun test is ACTUALLY invoked (not silently skipped).
// A buggy implementation that returned early without invoking bun test would
// pass U-VA-07's weak assertion (passing test, no throw). Using a FAILING test
// forces the cascade to invoke bun test; if bun test is actually invoked, the
// failing assertion throws and the cascade rejects.
describe("U-VA-07b | runTestCascade — auto-discovered bun test is actually invoked on failing tests", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		// Failing test, no STACK_EVAL.yaml, no package.json → falls through to
		// auto-discovery (bun test on *.test.ts files).
		fs.writeFileSync(
			path.join(repo.dir, "failing.test.ts"),
			`import { expect, test } from "bun:test";\ntest("fail", () => { expect(true).toBe(false); });\n`,
		);
	});
	afterAll(() => repo.dispose());

	test("auto-discovered bun test runs and rejects on a failing test", async () => {
		await expect(runTestCascade(repo.dir)).rejects.toThrow();
	});
});

// ─── U-VA-08 : no-op when no tests found ─────────────────────────────────────

describe("U-VA-08 | runTestCascade — silent when no test runner detected", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		// No test files, no STACK_EVAL.yaml, no package.json
	});
	afterAll(() => repo.dispose());

	test("resolves without error when no test runner is found", async () => {
		await expect(runTestCascade(repo.dir)).resolves.toBeUndefined();
	});
});

// ─── U-VA-09 : diffHash is deterministic ─────────────────────────────────────

describe("U-VA-09 | diffHash is deterministic for the same diff content", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("det.ts", "export const det = 'deterministic';\n");
	});
	afterAll(() => repo.dispose());

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
		expect(result1.diffHash).toBe(result2.diffHash);
	});
});
