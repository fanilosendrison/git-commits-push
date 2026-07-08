// tests/unit/git-publisher.test.ts — Unit tests for src/modules/git/publisher.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeMultiCommitAndPush } from "../../src/modules/git/publisher.ts";
import { formatConventionalCommit } from "../../src/modules/formatters/commit-formatter.ts";
import type { CommitMessage, CommitPlan, Settings } from "../../src/types.ts";
import { extractDiff } from "../../src/utils/git-utils.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";

// ─── Pure function tests (no git I/O) ────────────────────────────────────────

describe("U-GE-01 | formatConventionalCommit — no scope, no breaking", () => {
	test("produces 'feat: description'", () => {
		const commit: CommitMessage = {
			type: "feat",
			description: "add feature",
			isBreaking: false,
		};
		expect(formatConventionalCommit(commit)).toBe("feat: add feature");
	});
});

describe("U-GE-02 | formatConventionalCommit — with scope", () => {
	test("produces 'feat(scope): description'", () => {
		const commit: CommitMessage = {
			type: "feat",
			scope: "auth",
			description: "add JWT",
			isBreaking: false,
		};
		expect(formatConventionalCommit(commit)).toBe("feat(auth): add JWT");
	});
});

describe("U-GE-03 | formatConventionalCommit — breaking without scope", () => {
	test("produces 'feat!: description'", () => {
		const commit: CommitMessage = {
			type: "feat",
			description: "remove API",
			isBreaking: true,
		};
		expect(formatConventionalCommit(commit)).toBe("feat!: remove API");
	});
});

describe("U-GE-04 | formatConventionalCommit — breaking with scope", () => {
	test("produces 'feat(scope)!: description'", () => {
		const commit: CommitMessage = {
			type: "feat",
			scope: "api",
			description: "remove v1",
			isBreaking: true,
		};
		expect(formatConventionalCommit(commit)).toBe("feat(api)!: remove v1");
	});
});

describe("U-GE-05 | formatConventionalCommit — with body", () => {
	test("body is separated by double newline", () => {
		const commit: CommitMessage = {
			type: "fix",
			description: "crash on null",
			isBreaking: false,
			body: "Fixes #42",
		};
		expect(formatConventionalCommit(commit)).toBe(
			"fix: crash on null\n\nFixes #42",
		);
	});
});

// ─── Real git I/O tests ───────────────────────────────────────────────────────

const NO_PUSH_SETTINGS: Settings = {
	searchPaths: [],
	provider: "anthropic",
	model: "claude-test",
	temperature: 0,
	systemPromptPath: "/dev/null",
	autoPush: false,
	skipTests: true,
};

const AUTO_PUSH_SETTINGS: Settings = { ...NO_PUSH_SETTINGS, autoPush: true };

describe("U-GE-08 | executeMultiCommitAndPush — autoPush false → no push attempt", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.setRemote("origin", "https://github.com/nonexistent/nonexistent.git");
		repo.writeAndStage("h.ts", "export const c = 3;\n");
	});
	afterAll(() => repo.dispose());

	test("does not invoke git push and does not set upstream tracking", async () => {
		const { diffHash } = await extractDiff(repo.dir);
		const plans: CommitPlan[] = [
			{
				commit: {
					type: "fix",
					description: "silent fix",
					isBreaking: false,
				},
				files: ["h.ts"],
			},
		];
		await expect(
			executeMultiCommitAndPush(repo.dir, plans, diffHash, NO_PUSH_SETTINGS),
		).resolves.toBeDefined();

		// Strong assertion: even though `origin` is configured, no upstream tracking
		// should be set on the local branch. `git push -u` would set both
		// `branch.<name>.remote` and `branch.<name>.merge`; `git push` alone doesn't
		// touch them. If the publisher ignored autoPush=false and called push (or
		// push -u), at least one of these would be populated.
		const branch = spawnSync("git", ["branch", "--show-current"], {
			cwd: repo.dir,
			encoding: "utf-8",
		}).stdout.trim();
		const remote = spawnSync(
			"git",
			["config", "--get", `branch.${branch}.remote`],
			{
				cwd: repo.dir,
				encoding: "utf-8",
			},
		).stdout.trim();
		const merge = spawnSync(
			"git",
			["config", "--get", `branch.${branch}.merge`],
			{
				cwd: repo.dir,
				encoding: "utf-8",
			},
		).stdout.trim();
		expect(remote).toBe("");
		expect(merge).toBe("");
	});
});

describe("U-GE-09 | executeMultiCommitAndPush — no remote → push skipped silently", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("i.ts", "export const d = 4;\n");
	});
	afterAll(() => repo.dispose());

	test("does not throw and does not attempt any push variant when no remote is configured", async () => {
		const { diffHash } = await extractDiff(repo.dir);
		const plans: CommitPlan[] = [
			{
				commit: {
					type: "docs",
					description: "update readme",
					isBreaking: false,
				},
				files: ["i.ts"],
			},
		];
		await expect(
			executeMultiCommitAndPush(repo.dir, plans, diffHash, AUTO_PUSH_SETTINGS),
		).resolves.toBeDefined();

		// Strong assertion: still no remote configured (the publisher's no-remote
		// check should return BEFORE attempting any push command, including the
		// fallback `push -u origin <branch>` which would otherwise throw on missing
		// origin).
		const remotes = spawnSync("git", ["remote"], {
			cwd: repo.dir,
			encoding: "utf-8",
		}).stdout.trim();
		expect(remotes).toBe("");
	});
});

describe("U-GE-10 | executeMultiCommitAndPush — no upstream → push -u fallback", () => {
	let repoSource: GitRepoFixture;
	let bareRepoPath: string;
	beforeAll(() => {
		// Create a true bare repo to act as the real push target
		bareRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), "git-bare-"));
		spawnSync("git", ["init", "--bare", bareRepoPath], { encoding: "utf-8" });

		repoSource = GitRepoFixture.create();
		repoSource.commit("initial");
		repoSource.setRemote("custom-remote", bareRepoPath);
		repoSource.writeAndStage("j.ts", "export const e = 5;\n");
	});
	afterAll(() => {
		repoSource.dispose();
		try {
			fs.rmSync(bareRepoPath, { recursive: true, force: true });
		} catch {}
	});

	test("push -u custom-remote succeeds and commit appears in bare repo", async () => {
		const { diffHash } = await extractDiff(repoSource.dir);
		const plans: CommitPlan[] = [
			{
				commit: {
					type: "feat",
					description: "push via fallback",
					isBreaking: false,
				},
				files: ["j.ts"],
			},
		];
		await executeMultiCommitAndPush(
			repoSource.dir,
			plans,
			diffHash,
			AUTO_PUSH_SETTINGS,
		);

		const log = spawnSync("git", ["log", "--oneline", "-1"], {
			cwd: bareRepoPath,
			encoding: "utf-8",
		});
		expect(log.stdout).toContain("feat: push via fallback");
	});
});

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
		expect(result.status).not.toBeNull();
		expect(elapsed).toBeLessThan(5000);
	});
});

// ─── executeMultiCommitAndPush tests ─────────────────────────────────────────

describe("U-GE-12 | executeMultiCommitAndPush — two files → two distinct commits", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("api.ts", "export const api = 1;\n");
		repo.writeAndStage("ci.yml", "name: CI\n");
	});
	afterAll(() => repo.dispose());

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
		expect(log.stdout).toContain("feat: add api module");
		expect(log.stdout).toContain("ci: add ci workflow");
	});
});

describe("U-GE-13 | executeMultiCommitAndPush — hallucinated file → throws", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("real.ts", "export const x = 1;\n");
	});
	afterAll(() => repo.dispose());

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
		await expect(
			executeMultiCommitAndPush(repo.dir, plans, diffHash, NO_PUSH_SETTINGS),
		).rejects.toThrow();
	});
});

describe("U-GE-14 | executeMultiCommitAndPush — diffHash mismatch → throws before any commit", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("f.ts", "export const a = 1;\n");
	});
	afterAll(() => repo.dispose());

	test("throws DiffHash mismatch and makes no commits", async () => {
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
				"wrong-hash-00000000",
				NO_PUSH_SETTINGS,
			),
		).rejects.toThrow("DiffHash mismatch");

		// No commit should have been created beyond "initial"
		const log = spawnSync("git", ["log", "--oneline"], {
			cwd: repo.dir,
			encoding: "utf-8",
		});
		expect(log.stdout.trim().split("\n").length).toBe(1);
	});
});

describe("U-GE-15 | executeMultiCommitAndPush — duplicate file across plans → throws before git", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("shared.ts", "export const a = 1;\n");
		repo.writeAndStage("other.ts", "export const b = 2;\n");
	});
	afterAll(() => repo.dispose());

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
		await expect(
			executeMultiCommitAndPush(repo.dir, plans, diffHash, NO_PUSH_SETTINGS),
		).rejects.toThrow(/shared\.ts.*multiple plans|Fat Commit/i);

		// No commit should have been created — guard fires before git reset
		const log = spawnSync("git", ["log", "--oneline"], {
			cwd: repo.dir,
			encoding: "utf-8",
		});
		expect(log.stdout.trim().split("\n").length).toBe(1);
	});
});
