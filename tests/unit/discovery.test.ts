// tests/unit/discovery.test.ts — Unit tests for src/modules/discovery.ts
// and the git-utils helpers it composes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.checkoutDetached();
	});
	afterAll(() => repo.dispose());

	test("returns true for a repo in detached HEAD state", () => {
		expect(isDetachedHead(repo.dir)).toBe(true);
	});
});

describe("U-DI-02 | isDetachedHead — normal branch", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
	});
	afterAll(() => repo.dispose());

	test("returns false for a repo on a named branch", () => {
		expect(isDetachedHead(repo.dir)).toBe(false);
	});
});

// ─── hasLocalChanges ─────────────────────────────────────────────────────────

describe("U-DI-03 | hasLocalChanges — repo with staged file", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.writeAndStage("dirty.ts", "export const x = 1;\n");
	});
	afterAll(() => repo.dispose());

	test("returns true when there are staged changes", () => {
		expect(hasLocalChanges(repo.dir)).toBe(true);
	});
});

describe("U-DI-04 | hasLocalChanges — clean repo", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
	});
	afterAll(() => repo.dispose());

	test("returns false for a clean repo", () => {
		expect(hasLocalChanges(repo.dir)).toBe(false);
	});
});

// ─── hasUnpushedCommits ──────────────────────────────────────────────────────

describe("U-DI-05 | hasUnpushedCommits — local commit, no upstream", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
		repo.commit("local commit");
		// No remote/upstream configured → fallback to git cherry -v
	});
	afterAll(() => repo.dispose());

	test("returns true for a local commit with no upstream", () => {
		// git cherry -v should show the commit
		expect(hasUnpushedCommits(repo.dir)).toBe(true);
	});
});

// ─── findGitDirectoriesRecursively ───────────────────────────────────────────

describe("U-DI-06 | findGitDirectoriesRecursively — ignores node_modules", () => {
	let tmpRoot: string;
	let repoDir: string;

	beforeAll(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-06-"));
		repoDir = path.join(tmpRoot, "my-repo");
		fs.mkdirSync(repoDir);
		fs.mkdirSync(path.join(repoDir, ".git"));
		// Create a node_modules/nested-repo that should be ignored
		const nodeModulesRepo = path.join(tmpRoot, "node_modules", "pkg", ".git");
		fs.mkdirSync(nodeModulesRepo, { recursive: true });
	});
	afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

	test("does not return repos inside node_modules", () => {
		const found = findGitDirectoriesRecursively(tmpRoot);
		expect(found).toContain(repoDir);
		expect(found.some((p) => p.includes("node_modules"))).toBe(false);
	});
});

describe("U-DI-07 | findGitDirectoriesRecursively — stops at first .git (no nested repos)", () => {
	let tmpRoot: string;

	beforeAll(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-07-"));
		// outer-repo/.git
		fs.mkdirSync(path.join(tmpRoot, "outer-repo", ".git"), { recursive: true });
		// outer-repo/inner-repo/.git  → must NOT be returned
		fs.mkdirSync(path.join(tmpRoot, "outer-repo", "inner-repo", ".git"), {
			recursive: true,
		});
	});
	afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

	test("returns only the top-level repo, not the nested one", () => {
		const found = findGitDirectoriesRecursively(tmpRoot);
		expect(found).toHaveLength(1);
		expect(found[0]).toContain("outer-repo");
	});
});

// ─── runDiscovery ────────────────────────────────────────────────────────────

describe("U-DI-08 | runDiscovery — non-existent path does not crash", () => {
	test("resolves with empty array for a non-existent search path", async () => {
		const settings: Settings = {
			...BASE_SETTINGS,
			searchPaths: ["/non/existent/path/that/does/not/exist"],
		};
		await expect(runDiscovery(settings)).resolves.toEqual([]);
	});
});

describe("U-DI-09 | runDiscovery — excludes detached HEAD repos", () => {
	let repoDetached: GitRepoFixture;

	beforeAll(() => {
		repoDetached = GitRepoFixture.create();
		repoDetached.commit("initial");
		repoDetached.checkoutDetached();
		repoDetached.writeAndStage("file.ts", "const x = 1;\n");
	});
	afterAll(() => repoDetached.dispose());

	test("detached HEAD repo is not returned even if it has staged changes", async () => {
		const settings: Settings = {
			...BASE_SETTINGS,
			// Scope to the repo dir directly — do NOT use path.dirname(repoDetached.dir)
			// which resolves to os.tmpdir() and causes findGitDirectoriesRecursively
			// to crawl the entire system temp folder (huge, 30s+ on macOS).
			searchPaths: [repoDetached.dir],
		};
		const results = await runDiscovery(settings);
		expect(results.some((r) => r.path === repoDetached.dir)).toBe(false);
	});
});

describe("U-DI-10 | computeRepoId — deterministic across calls", () => {
	let repo: GitRepoFixture;
	beforeAll(() => {
		repo = GitRepoFixture.create();
	});
	afterAll(() => repo.dispose());

	test("same path always produces the same ID", async () => {
		const id1 = await computeRepoId(repo.dir);
		const id2 = await computeRepoId(repo.dir);
		expect(id1).toBe(id2);
		expect(id1.length).toBeGreaterThan(0);
	});
});
