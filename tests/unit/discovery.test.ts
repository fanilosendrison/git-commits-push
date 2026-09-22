// tests/unit/discovery.test.ts — Unit tests for src/modules/discovery.ts
// and the git-utils helpers it composes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { runDiscovery } from "../../src/modules/core/discovery.ts";
import {
	GLOBAL_INVOCATION_SCOPE,
	resolveInvocationScope,
} from "../../src/modules/invocation/invocation-scope.ts";
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

test("U-DI-01 | isDetachedHead — detached HEAD repo", (t) => {
	const repo = GitRepoFixture.create();
	t.after(() => repo.dispose());
	repo.commit("initial");
	repo.checkoutDetached();
	assert.strictEqual(isDetachedHead(repo.dir), true);
});

test("U-DI-02 | isDetachedHead — normal branch", (t) => {
	const repo = GitRepoFixture.create();
	t.after(() => repo.dispose());
	repo.commit("initial");
	assert.strictEqual(isDetachedHead(repo.dir), false);
});

// ─── hasLocalChanges ─────────────────────────────────────────────────────────

test("U-DI-03 | hasLocalChanges — repo with staged file", (t) => {
	const repo = GitRepoFixture.create();
	t.after(() => repo.dispose());
	repo.commit("initial");
	repo.writeAndStage("dirty.ts", "export const x = 1;\n");
	assert.strictEqual(hasLocalChanges(repo.dir), true);
});

test("U-DI-04 | hasLocalChanges — clean repo", (t) => {
	const repo = GitRepoFixture.create();
	t.after(() => repo.dispose());
	repo.commit("initial");
	assert.strictEqual(hasLocalChanges(repo.dir), false);
});

// ─── hasUnpushedCommits ──────────────────────────────────────────────────────

test("U-DI-05 | hasUnpushedCommits — local commit, no upstream", (t) => {
	const repo = GitRepoFixture.create();
	t.after(() => repo.dispose());
	repo.commit("local commit");
	assert.strictEqual(hasUnpushedCommits(repo.dir), true);
});

// ─── findGitDirectoriesRecursively ───────────────────────────────────────────

test("U-DI-06 | findGitDirectoriesRecursively — ignores node_modules", (t) => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-06-"));
	t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
	const repoDir = path.join(tmpRoot, "my-repo");
	fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
	fs.mkdirSync(path.join(tmpRoot, "node_modules", "pkg", ".git"), {
		recursive: true,
	});

	const found = findGitDirectoriesRecursively(tmpRoot);
	assert.ok(found.includes(repoDir));
	assert.strictEqual(
		found.some((entry) => entry.includes("node_modules")),
		false,
	);
});

test("U-DI-07 | findGitDirectoriesRecursively — stops at first .git", (t) => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-07-"));
	t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
	fs.mkdirSync(path.join(tmpRoot, "outer-repo", ".git"), { recursive: true });
	fs.mkdirSync(path.join(tmpRoot, "outer-repo", "inner-repo", ".git"), {
		recursive: true,
	});

	const found = findGitDirectoriesRecursively(tmpRoot);
	assert.strictEqual(found.length, 1);
	assert.ok(found[0]?.includes("outer-repo"));
});

// ─── runDiscovery ────────────────────────────────────────────────────────────

describe("U-DI-08 | runDiscovery — non-existent path does not crash", () => {
	test("resolves with empty array for a non-existent search path", async () => {
		const settings: Settings = {
			...BASE_SETTINGS,
			searchPaths: ["/non/existent/path/that/does/not/exist"],
		};
		await assert.deepStrictEqual(
			await runDiscovery(settings, GLOBAL_INVOCATION_SCOPE),
			[],
		);
	});
});

test("U-DI-09 | runDiscovery — excludes detached HEAD repos", async (t) => {
	const repo = GitRepoFixture.create();
	t.after(() => repo.dispose());
	repo.commit("initial");
	repo.checkoutDetached();
	repo.writeAndStage("file.ts", "const x = 1;\n");

	const results = await runDiscovery(
		{ ...BASE_SETTINGS, searchPaths: [repo.dir] },
		GLOBAL_INVOCATION_SCOPE,
	);
	assert.strictEqual(
		results.some((result) => result.path === repo.dir),
		false,
	);
});

test("U-DI-10 | computeRepoId — deterministic across calls", async (t) => {
	const repo = GitRepoFixture.create();
	t.after(() => repo.dispose());
	const first = await computeRepoId(repo.dir);
	assert.strictEqual(await computeRepoId(repo.dir), first);
	assert.ok(first.length > 0);
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
		const results = await runDiscovery(
			{
				...BASE_SETTINGS,
				autoPush: true,
				searchPaths: [repo.dir],
			},
			GLOBAL_INVOCATION_SCOPE,
		);

		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0]?.path, repo.dir);
		assert.strictEqual(results[0]?.operation, "push-only");
	});

	test("fails the pass when an ahead repository cannot inspect its remote", async () => {
		const unavailablePath = `${remotePath}.unavailable`;
		fs.renameSync(remotePath, unavailablePath);
		try {
			await assert.rejects(
				runDiscovery(
					{
						...BASE_SETTINGS,
						autoPush: true,
						searchPaths: [repo.dir],
					},
					GLOBAL_INVOCATION_SCOPE,
				),
				/Cannot inspect tracked push destination/iu,
			);
		} finally {
			fs.renameSync(unavailablePath, remotePath);
		}
	});

	test("excludes the repository when auto-push is disabled", async () => {
		const results = await runDiscovery(
			{
				...BASE_SETTINGS,
				autoPush: false,
				searchPaths: [repo.dir],
			},
			GLOBAL_INVOCATION_SCOPE,
		);

		assert.deepStrictEqual(results, []);
	});
});

// ─── Targeted discovery ──────────────────────────────────────────────────────

function createBareRemote(prefix: string): { root: string; path: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-remote-`));
	const remotePath = path.join(root, "remote.git");
	execFileSync("git", ["init", "--bare", remotePath]);
	return { root, path: remotePath };
}

function targetedScope(repository: string, pushRef = "refs/heads/main") {
	return resolveInvocationScope({
		kind: "targeted",
		repository,
		pushRemote: "origin",
		pushRef,
	});
}

function addLinkedWorktree(
	repository: string,
	worktree: string,
	branch: string,
) {
	execFileSync(
		"git",
		["-C", repository, "worktree", "add", worktree, "-b", branch],
		{ stdio: "pipe" },
	);
}

function stageWorktreeFile(worktree: string, file: string, source: string) {
	fs.writeFileSync(path.join(worktree, file), source);
	execFileSync("git", ["-C", worktree, "add", "-A"], { stdio: "pipe" });
}

test("U-DI-12 | targeted discovery includes a detached dirty target", async (t) => {
	const remote = createBareRemote("di-12");
	const repo = GitRepoFixture.create();
	t.after(() => {
		repo.dispose();
		fs.rmSync(remote.root, { recursive: true, force: true });
	});
	repo.commit("initial");
	repo.setRemote("origin", remote.path);
	repo.checkoutDetached();
	repo.writeAndStage("detached-change.ts", "export const detached = true;\n");

	const results = await runDiscovery(
		{ ...BASE_SETTINGS, searchPaths: [repo.dir] },
		targetedScope(repo.dir),
	);
	assert.strictEqual(results.length, 1);
	assert.strictEqual(results[0]?.path, fs.realpathSync(repo.dir));
	assert.strictEqual(results[0]?.operation, "commit-and-push");
});

test("U-DI-13 | targeted discovery ignores broad searchPaths", async (t) => {
	const searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-13-"));
	const remote = createBareRemote("di-13");
	const target = GitRepoFixture.create({ parentDir: searchRoot });
	const unrelated = GitRepoFixture.create({ parentDir: searchRoot });
	t.after(() => {
		target.dispose();
		unrelated.dispose();
		fs.rmSync(searchRoot, { recursive: true, force: true });
		fs.rmSync(remote.root, { recursive: true, force: true });
	});
	target.commit("initial");
	target.setRemote("origin", remote.path);
	target.writeAndStage("target-change.ts", "export const target = true;\n");
	unrelated.commit("initial");
	unrelated.writeAndStage(
		"unrelated-change.ts",
		"export const unrelated = true;\n",
	);

	const results = await runDiscovery(
		{ ...BASE_SETTINGS, searchPaths: [searchRoot] },
		targetedScope(target.dir),
	);
	assert.deepStrictEqual(
		results.map((result) => result.path),
		[fs.realpathSync(target.dir)],
	);
});

test("U-DI-14 | targeted discovery isolates linked worktrees", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "di-14-"));
	const remote = createBareRemote("di-14");
	const persistent = GitRepoFixture.create({ parentDir: root });
	t.after(() => {
		persistent.dispose();
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(remote.root, { recursive: true, force: true });
	});
	persistent.commit("initial");
	persistent.setRemote("origin", remote.path);
	const targetPath = path.join(root, "target-worktree");
	const siblingPath = path.join(root, "sibling-worktree");
	addLinkedWorktree(persistent.dir, targetPath, "target-branch");
	addLinkedWorktree(persistent.dir, siblingPath, "sibling-branch");
	persistent.writeAndStage(
		"persistent-change.ts",
		"export const persistent = true;\n",
	);
	stageWorktreeFile(
		targetPath,
		"target-change.ts",
		"export const target = true;\n",
	);
	stageWorktreeFile(
		siblingPath,
		"sibling-change.ts",
		"export const sibling = true;\n",
	);

	const canonicalTarget = fs.realpathSync(targetPath);
	const results = await runDiscovery(
		{ ...BASE_SETTINGS, searchPaths: [root] },
		targetedScope(targetPath, "refs/heads/target-branch"),
	);
	assert.deepStrictEqual(
		results.map((result) => result.path),
		[canonicalTarget],
	);
	assert.strictEqual(
		results.some((result) => result.path === fs.realpathSync(siblingPath)),
		false,
	);
	assert.strictEqual(
		results.some((result) => result.path === fs.realpathSync(persistent.dir)),
		false,
	);
});

test("U-DI-15 | targeted clean result is independent of autoPush", async (t) => {
	const remote = createBareRemote("di-15");
	const repo = GitRepoFixture.create();
	t.after(() => {
		repo.dispose();
		fs.rmSync(remote.root, { recursive: true, force: true });
	});
	repo.commit("initial");
	repo.setRemote("origin", remote.path);
	const scope = targetedScope(repo.dir);

	// Explicit-target clean push-only is deferred to explicit-target publication;
	// autoPush is a global-mode policy and is not targeted authority.
	const disabled = await runDiscovery(
		{ ...BASE_SETTINGS, autoPush: false, searchPaths: [repo.dir] },
		scope,
	);
	const enabled = await runDiscovery(
		{ ...BASE_SETTINGS, autoPush: true, searchPaths: [repo.dir] },
		scope,
	);
	assert.deepStrictEqual(disabled, []);
	assert.deepStrictEqual(enabled, []);
});
