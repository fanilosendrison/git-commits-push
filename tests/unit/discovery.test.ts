// tests/unit/discovery.test.ts — Unit tests for src/modules/discovery.ts
// and the git-utils helpers it composes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { runDiscovery } from "../../src/modules/core/discovery.ts";
import type { Settings } from "../../src/types.ts";
import {
	computeRepoId,
	findGitDirectoriesRecursively,
	hasLocalChanges,
	hasUnpushedCommits,
	isDetachedHead,
} from "../../src/utils/git-utils.ts";
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

// ─── isDetachedHead ──────────────────────────────────────────────────────────

describe("U-DI-01 | isDetachedHead — detached HEAD repo", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.checkoutDetached();
	});
	after(() => repo.dispose());

	test("returns true for a repo in detached HEAD state", () => {
		assert.strictEqual(isDetachedHead(repo.dir), true);
	});
});

describe("U-DI-02 | isDetachedHead — normal branch", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
	});
	after(() => repo.dispose());

	test("returns false for a repo on a named branch", () => {
		assert.strictEqual(isDetachedHead(repo.dir), false);
	});
});

// ─── hasLocalChanges ─────────────────────────────────────────────────────────

describe("U-DI-03 | hasLocalChanges — repo with staged file", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("dirty.ts", "export const x = 1;\n");
	});
	after(() => repo.dispose());

	test("returns true when there are staged changes", () => {
		assert.strictEqual(hasLocalChanges(repo.dir), true);
	});
});

describe("U-DI-04 | hasLocalChanges — clean repo", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
	});
	after(() => repo.dispose());

	test("returns false for a clean repo", () => {
		assert.strictEqual(hasLocalChanges(repo.dir), false);
	});
});

// ─── hasUnpushedCommits ──────────────────────────────────────────────────────

describe("U-DI-05 | hasUnpushedCommits — local commit, no upstream", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("local commit");
		// No remote/upstream configured → fallback to git cherry -v
	});
	after(() => repo.dispose());

	test("returns true for a local commit with no upstream", () => {
		// git cherry -v should show the commit
		assert.strictEqual(hasUnpushedCommits(repo.dir), true);
	});
});

// ─── findGitDirectoriesRecursively ───────────────────────────────────────────

describe("U-DI-06 | findGitDirectoriesRecursively — ignores node_modules", () => {
	let tmpRoot: string;
	let repoDir: string;

	before(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-06-"));
		repoDir = path.join(tmpRoot, "my-repo");
		fs.mkdirSync(repoDir);
		fs.mkdirSync(path.join(repoDir, ".git"));
		// Create a node_modules/nested-repo that should be ignored
		const nodeModulesRepo = path.join(tmpRoot, "node_modules", "pkg", ".git");
		fs.mkdirSync(nodeModulesRepo, { recursive: true });
	});
	after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

	test("does not return repos inside node_modules", () => {
		const found = findGitDirectoriesRecursively(tmpRoot);
		assert.ok(found.includes(repoDir));
		assert.strictEqual(
			found.some((p) => p.includes("node_modules")),
			false,
		);
	});
});

describe("U-DI-07 | findGitDirectoriesRecursively — stops at first .git (no nested repos)", () => {
	let tmpRoot: string;

	before(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-07-"));
		// outer-repo/.git
		fs.mkdirSync(path.join(tmpRoot, "outer-repo", ".git"), { recursive: true });
		// outer-repo/inner-repo/.git  → must NOT be returned
		fs.mkdirSync(path.join(tmpRoot, "outer-repo", "inner-repo", ".git"), {
			recursive: true,
		});
	});
	after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

	test("returns only the top-level repo, not the nested one", () => {
		const found = findGitDirectoriesRecursively(tmpRoot);
		assert.strictEqual(found.length, 1);
		assert.ok(found[0]?.includes("outer-repo"));
	});
});

// ─── runDiscovery ────────────────────────────────────────────────────────────

describe("U-DI-08 | runDiscovery — non-existent path does not crash", () => {
	test("resolves with empty array for a non-existent search path", async () => {
		const settings: Settings = {
			...BASE_SETTINGS,
			searchPaths: ["/non/existent/path/that/does/not/exist"],
		};
		await assert.deepStrictEqual(await runDiscovery(settings), []);
	});
});

describe("U-DI-09 | runDiscovery — excludes detached HEAD repos", () => {
	let repoDetached: GitRepoFixture;

	before(() => {
		repoDetached = GitRepoFixture.create();
		repoDetached.commit("initial");
		repoDetached.checkoutDetached();
		repoDetached.writeAndStage("file.ts", "const x = 1;\n");
	});
	after(() => repoDetached.dispose());

	test("detached HEAD repo is not returned even if it has staged changes", async () => {
		const settings: Settings = {
			...BASE_SETTINGS,
			// Scope to the repo dir directly — do NOT use path.dirname(repoDetached.dir)
			// which resolves to os.tmpdir() and causes findGitDirectoriesRecursively
			// to crawl the entire system temp folder (huge, 30s+ on macOS).
			searchPaths: [repoDetached.dir],
		};
		const results = await runDiscovery(settings);
		assert.strictEqual(
			results.some((r) => r.path === repoDetached.dir),
			false,
		);
	});
});

describe("U-DI-10 | computeRepoId — deterministic across calls", () => {
	let repo: GitRepoFixture;
	before(() => {
		repo = GitRepoFixture.create();
	});
	after(() => repo.dispose());

	test("same path always produces the same ID", async () => {
		const id1 = await computeRepoId(repo.dir);
		const id2 = await computeRepoId(repo.dir);
		assert.strictEqual(id1, id2);
		assert.ok(id1.length > 0);
	});
});

describe("U-DI-11 | runDiscovery — clean tracked repository ahead of upstream", () => {
	let repo: GitRepoFixture;
	let remoteRoot: string;
	let remotePath: string;

	before(() => {
		remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-11-remote-"));
		remotePath = path.join(remoteRoot, "remote.git");
		execFileSync("git", ["init", "--bare", remotePath]);
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.setRemote("origin", remotePath);
		const branch = execFileSync(
			"git",
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			{ cwd: repo.dir, encoding: "utf8" },
		).trim();
		execFileSync("git", ["push", "--set-upstream", "origin", branch], {
			cwd: repo.dir,
		});
		repo.writeAndStage("ahead.ts", "export const ahead = true;\n");
		repo.commit("add ahead commit");
	});

	after(() => {
		repo.dispose();
		fs.rmSync(remoteRoot, { recursive: true, force: true });
	});

	test("returns the repository as push-only when auto-push is enabled", async () => {
		const results = await runDiscovery({
			...BASE_SETTINGS,
			autoPush: true,
			searchPaths: [repo.dir],
		});

		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0]?.path, repo.dir);
		assert.strictEqual(results[0]?.operation, "push-only");
	});

	test("fails the pass when an ahead repository cannot inspect its remote", async () => {
		const unavailablePath = `${remotePath}.unavailable`;
		fs.renameSync(remotePath, unavailablePath);
		try {
			await assert.rejects(
				runDiscovery({
					...BASE_SETTINGS,
					autoPush: true,
					searchPaths: [repo.dir],
				}),
				/Cannot inspect tracked push destination/iu,
			);
		} finally {
			fs.renameSync(unavailablePath, remotePath);
		}
	});

	test("excludes the repository when auto-push is disabled", async () => {
		const results = await runDiscovery({
			...BASE_SETTINGS,
			autoPush: false,
			searchPaths: [repo.dir],
		});

		assert.deepStrictEqual(results, []);
	});
});
