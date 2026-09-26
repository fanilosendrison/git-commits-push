// tests/unit/discovery.test.ts — Unit tests for src/modules/discovery.ts
// and the git-utils helpers it composes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
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
import { captureRepositoryState } from "../helpers/test-helpers.ts";

const BASE_SETTINGS: Settings = {
	searchPaths: [],
	provider: "anthropic",
	model: "claude-test",
	temperature: 0,
	systemPromptPath: "/dev/null",
	autoPush: false,
	skipTests: true,
};

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", [...args], {
		cwd,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}

interface TargetFixture {
	readonly repo: GitRepoFixture;
	readonly remoteRoot: string;
	readonly remotePath: string;
	readonly branch: string;
	readonly baseline: string;
	readonly destinationRef: string;
}

/** A repository whose upstream branch already exists on a real bare remote. */
function createTargetFixture(parentDir?: string): TargetFixture {
	const remoteRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "di-target-remote-"),
	);
	const remotePath = path.join(remoteRoot, "remote.git");
	execFileSync("git", ["init", "--bare", remotePath], { stdio: "pipe" });
	const repo = GitRepoFixture.create(parentDir ? { parentDir } : undefined);
	repo.commit("initial");
	repo.setRemote("origin", remotePath);
	const branch = git(repo.dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	git(repo.dir, ["push", "--set-upstream", "origin", branch]);
	return {
		repo,
		remoteRoot,
		remotePath,
		branch,
		baseline: git(repo.dir, ["rev-parse", "HEAD"]),
		destinationRef: `refs/heads/${branch}`,
	};
}

function disposeTargetFixture(fixture: TargetFixture): void {
	fixture.repo.dispose();
	fs.rmSync(fixture.remoteRoot, { recursive: true, force: true });
}

function targetedScope(
	fixture: TargetFixture,
	pushRef = fixture.destinationRef,
	repository = fixture.repo.dir,
) {
	return resolveInvocationScope({
		kind: "targeted",
		repository,
		pushRemote: "origin",
		pushRef,
	});
}

function settingsFor(
	fixture: TargetFixture,
	overrides: Partial<Settings> = {},
): Settings {
	return {
		...BASE_SETTINGS,
		searchPaths: [fixture.repo.dir],
		...overrides,
	};
}

function commitOnHead(fixture: TargetFixture, file: string): string {
	fixture.repo.writeAndStage(file, `export const ${file} = true;\n`);
	git(fixture.repo.dir, ["commit", "--no-verify", "-m", `add ${file}`]);
	return git(fixture.repo.dir, ["rev-parse", "HEAD"]);
}

/** Move the destination to a new commit on top of the frozen baseline. */
function moveRemoteDestination(fixture: TargetFixture): string {
	const tree = git(fixture.repo.dir, [
		"rev-parse",
		`${fixture.baseline}^{tree}`,
	]);
	const sha = git(fixture.repo.dir, [
		"commit-tree",
		tree,
		"-p",
		fixture.baseline,
		"-m",
		"concurrent publication",
	]);
	git(fixture.repo.dir, [
		"push",
		fixture.remotePath,
		`${sha}:${fixture.destinationRef}`,
	]);
	return sha;
}
// ─── git-utils helpers ───────────────────────────────────────────────────────

test("U-DI-01/02 | isDetachedHead — detached and attached repositories", (t) => {
	const detached = GitRepoFixture.create();
	const attached = GitRepoFixture.create();
	t.after(() => {
		detached.dispose();
		attached.dispose();
	});
	detached.commit("initial");
	detached.checkoutDetached();
	attached.commit("initial");
	assert.strictEqual(isDetachedHead(detached.dir), true);
	assert.strictEqual(isDetachedHead(attached.dir), false);
});

test("U-DI-03/04 | hasLocalChanges — staged changes and clean state", (t) => {
	const dirty = GitRepoFixture.create();
	const clean = GitRepoFixture.create();
	t.after(() => {
		dirty.dispose();
		clean.dispose();
	});
	dirty.commit("initial");
	dirty.writeAndStage("dirty.ts", "export const x = 1;\n");
	clean.commit("initial");
	assert.strictEqual(hasLocalChanges(dirty.dir), true);
	assert.strictEqual(hasLocalChanges(clean.dir), false);
});

test("U-DI-05 | hasUnpushedCommits — local commit, no upstream", (t) => {
	const repo = GitRepoFixture.create();
	t.after(() => repo.dispose());
	repo.commit("local commit");
	assert.strictEqual(hasUnpushedCommits(repo.dir), true);
});

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
// ─── Worktree discovery ──────────────────────────────────────────────────────

function worktreeScope(repo: GitRepoFixture) {
	return resolveInvocationScope({ kind: "worktree" }, repo.dir);
}

test("U-DI-08 | runDiscovery — a dirty worktree returns exactly itself", async (t) => {
	const fixture = createTargetFixture();
	t.after(() => disposeTargetFixture(fixture));
	fixture.repo.writeAndStage("dirty.ts", "export const dirty = true;\n");
	const results = await runDiscovery(
		settingsFor(fixture),
		worktreeScope(fixture.repo),
	);
	assert.strictEqual(results.length, 1);
	assert.strictEqual(results[0]?.path, fs.realpathSync(fixture.repo.dir));
	assert.strictEqual(results[0]?.operation, "commit-and-push");
	assert.strictEqual(results[0]?.pushSnapshot, undefined);
	assert.strictEqual(results[0]?.explicitPushTargetSnapshot, undefined);
});

test("U-DI-09 | runDiscovery — a dirty linked sibling worktree is ignored", async (t) => {
	const searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-09-"));
	const fixture = createTargetFixture(searchRoot);
	const siblingPath = path.join(searchRoot, "sibling-worktree");
	t.after(() => {
		disposeTargetFixture(fixture);
		fs.rmSync(searchRoot, { recursive: true, force: true });
	});
	git(fixture.repo.dir, [
		"worktree",
		"add",
		siblingPath,
		"-b",
		"sibling-branch",
	]);
	fs.writeFileSync(
		path.join(siblingPath, "sibling.ts"),
		"export const sibling = true;\n",
	);
	git(siblingPath, ["add", "-A"]);
	fixture.repo.writeAndStage("current.ts", "export const current = true;\n");

	const results = await runDiscovery(
		settingsFor(fixture, { searchPaths: [searchRoot] }),
		worktreeScope(fixture.repo),
	);
	assert.deepStrictEqual(
		results.map((result) => result.path),
		[fs.realpathSync(fixture.repo.dir)],
	);
	assert.strictEqual(
		results.some((result) => result.path === fs.realpathSync(siblingPath)),
		false,
	);
});

test("U-DI-10 | runDiscovery — an unrelated dirty repository in searchPaths is ignored", async (t) => {
	const searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-10-"));
	const fixture = createTargetFixture(searchRoot);
	const unrelated = GitRepoFixture.create({ parentDir: searchRoot });
	unrelated.commit("initial");
	unrelated.writeAndStage("unrelated.ts", "export const unrelated = true;\n");
	t.after(() => {
		disposeTargetFixture(fixture);
		unrelated.dispose();
		fs.rmSync(searchRoot, { recursive: true, force: true });
	});
	fixture.repo.writeAndStage("current.ts", "export const current = true;\n");

	const results = await runDiscovery(
		settingsFor(fixture, { searchPaths: [searchRoot] }),
		worktreeScope(fixture.repo),
	);
	assert.deepStrictEqual(
		results.map((result) => result.path),
		[fs.realpathSync(fixture.repo.dir)],
	);
	assert.strictEqual(
		results.some((result) => result.path === fs.realpathSync(unrelated.dir)),
		false,
	);
});

test("U-DI-11 | runDiscovery — a clean worktree never falls through to a dirty sibling", async (t) => {
	const searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-11-"));
	const fixture = createTargetFixture(searchRoot);
	const siblingPath = path.join(searchRoot, "sibling-worktree");
	t.after(() => {
		disposeTargetFixture(fixture);
		fs.rmSync(searchRoot, { recursive: true, force: true });
	});
	git(fixture.repo.dir, [
		"worktree",
		"add",
		siblingPath,
		"-b",
		"sibling-branch",
	]);
	fs.writeFileSync(
		path.join(siblingPath, "sibling.ts"),
		"export const sibling = true;\n",
	);
	git(siblingPath, ["add", "-A"]);

	// The current worktree is clean and fully synchronized, so it has nothing
	// publishable even with autoPush enabled.
	assert.deepStrictEqual(
		await runDiscovery(
			settingsFor(fixture, { autoPush: true, searchPaths: [searchRoot] }),
			worktreeScope(fixture.repo),
		),
		[],
	);
});

test("U-DI-17 | runDiscovery — worktree tracked push-only follows autoPush", async (t) => {
	const fixture = createTargetFixture();
	t.after(() => disposeTargetFixture(fixture));
	commitOnHead(fixture, "ahead.ts");
	const enabled = await runDiscovery(
		settingsFor(fixture, { autoPush: true }),
		worktreeScope(fixture.repo),
	);
	assert.strictEqual(enabled.length, 1);
	assert.strictEqual(enabled[0]?.path, fs.realpathSync(fixture.repo.dir));
	assert.strictEqual(enabled[0]?.operation, "push-only");
	assert.strictEqual(enabled[0]?.pushSnapshot?.kind, "tracked");
	assert.ok(enabled[0]?.explicitPushTargetSnapshot === undefined);
	fs.renameSync(fixture.remotePath, `${fixture.remotePath}.unavailable`);
	await assert.rejects(
		runDiscovery(
			settingsFor(fixture, { autoPush: true }),
			worktreeScope(fixture.repo),
		),
		/Cannot inspect tracked push destination/iu,
	);
	fs.renameSync(`${fixture.remotePath}.unavailable`, fixture.remotePath);
	assert.deepStrictEqual(
		await runDiscovery(
			settingsFor(fixture, { autoPush: false }),
			worktreeScope(fixture.repo),
		),
		[],
	);
});

test("U-DI-18 | runDiscovery — legacy global scope is rejected before any global discovery", async (t) => {
	const searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-18-"));
	const fixture = createTargetFixture(searchRoot);
	const unrelated = GitRepoFixture.create({ parentDir: searchRoot });
	unrelated.commit("initial");
	unrelated.writeAndStage("unrelated.ts", "export const unrelated = true;\n");
	fixture.repo.writeAndStage("legacy.ts", "export const legacy = true;\n");
	t.after(() => {
		disposeTargetFixture(fixture);
		unrelated.dispose();
		fs.rmSync(searchRoot, { recursive: true, force: true });
	});

	const fixtureBefore = captureRepositoryState(fixture.repo.dir);
	const unrelatedBefore = captureRepositoryState(unrelated.dir);

	await assert.rejects(
		runDiscovery(
			settingsFor(fixture, { searchPaths: [searchRoot] }),
			GLOBAL_INVOCATION_SCOPE,
		),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /legacy global/);
			assert.match(error.message, /non-executable/);
			return true;
		},
	);

	assert.deepStrictEqual(
		captureRepositoryState(fixture.repo.dir),
		fixtureBefore,
	);
	assert.deepStrictEqual(
		captureRepositoryState(unrelated.dir),
		unrelatedBefore,
	);
});
test("U-DI-19 | computeRepoId — deterministic across calls", async (t) => {
	const repo = GitRepoFixture.create();
	t.after(() => repo.dispose());
	const first = await computeRepoId(repo.dir);
	assert.strictEqual(await computeRepoId(repo.dir), first);
	assert.ok(first.length > 0);
});

// ─── Targeted discovery ──────────────────────────────────────────────────────

test("U-DI-12 | targeted discovery freezes the destination for a dirty detached target", async (t) => {
	const fixture = createTargetFixture();
	t.after(() => disposeTargetFixture(fixture));
	fixture.repo.checkoutDetached();
	fixture.repo.writeAndStage(
		"detached-change.ts",
		"export const detached = true;\n",
	);
	const results = await runDiscovery(
		settingsFor(fixture),
		targetedScope(fixture),
	);
	assert.strictEqual(results.length, 1);
	assert.strictEqual(results[0]?.path, fs.realpathSync(fixture.repo.dir));
	assert.strictEqual(results[0]?.operation, "commit-and-push");
	const snapshot = results[0]?.explicitPushTargetSnapshot;
	assert.strictEqual(snapshot?.remote, "origin");
	assert.strictEqual(snapshot?.destinationRef, fixture.destinationRef);
	assert.strictEqual(snapshot?.destinationBaselineSha, fixture.baseline);
	assert.match(snapshot?.pushUrlFingerprint ?? "", /^[a-f0-9]{64}$/u);
	assert.strictEqual(results[0]?.pushSnapshot, undefined);
});

test("U-DI-13 | targeted discovery ignores broad searchPaths", async (t) => {
	const searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-13-"));
	const fixture = createTargetFixture(searchRoot);
	const unrelated = GitRepoFixture.create({ parentDir: searchRoot });
	unrelated.commit("initial");
	unrelated.writeAndStage("unrelated.ts", "export const unrelated = true;\n");
	t.after(() => {
		disposeTargetFixture(fixture);
		unrelated.dispose();
		fs.rmSync(searchRoot, { recursive: true, force: true });
	});
	commitOnHead(fixture, "target-change.ts");
	const results = await runDiscovery(
		settingsFor(fixture, { searchPaths: [searchRoot] }),
		targetedScope(fixture),
	);
	assert.deepStrictEqual(
		results.map((result) => result.path),
		[fs.realpathSync(fixture.repo.dir)],
	);
});

test("U-DI-14 | targeted discovery isolates linked worktrees", async (t) => {
	const searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-14-"));
	const fixture = createTargetFixture(searchRoot);
	const targetPath = path.join(searchRoot, "target-worktree");
	const siblingPath = path.join(searchRoot, "sibling-worktree");
	t.after(() => {
		disposeTargetFixture(fixture);
		fs.rmSync(searchRoot, { recursive: true, force: true });
	});
	for (const [worktree, branch] of [
		[targetPath, "target-branch"],
		[siblingPath, "sibling-branch"],
	] as const) {
		git(fixture.repo.dir, ["worktree", "add", worktree, "-b", branch]);
		git(fixture.repo.dir, ["push", "origin", `${branch}:${branch}`]);
		fs.writeFileSync(
			path.join(worktree, `${branch}.ts`),
			"export const branch = true;\n",
		);
		git(worktree, ["add", "-A"]);
	}
	git(targetPath, ["checkout", "--detach"]);
	const results = await runDiscovery(
		settingsFor(fixture, { searchPaths: [searchRoot] }),
		targetedScope(fixture, "refs/heads/target-branch", targetPath),
	);
	assert.deepStrictEqual(
		results.map((result) => result.path),
		[fs.realpathSync(targetPath)],
	);
	for (const excluded of [siblingPath, fixture.repo.dir]) {
		assert.strictEqual(
			results.some((result) => result.path === fs.realpathSync(excluded)),
			false,
		);
	}
});

test("U-DI-15 | targeted clean worktrees publish only ahead of the frozen baseline", async (t) => {
	const fixture = createTargetFixture();
	t.after(() => disposeTargetFixture(fixture));
	// Already at the destination: no work under either autoPush mode.
	for (const autoPush of [false, true]) {
		assert.deepStrictEqual(
			await runDiscovery(
				settingsFor(fixture, { autoPush }),
				targetedScope(fixture),
			),
			[],
		);
	}
	// Ahead from a detached HEAD: explicit push-only under either autoPush mode.
	fixture.repo.checkoutDetached();
	const head = commitOnHead(fixture, "ahead.ts");
	for (const autoPush of [false, true]) {
		const results = await runDiscovery(
			settingsFor(fixture, { autoPush }),
			targetedScope(fixture),
		);
		assert.strictEqual(results[0]?.operation, "push-only");
		const snapshot = results[0]?.pushSnapshot;
		assert.strictEqual(snapshot?.kind, "explicit");
		if (snapshot?.kind !== "explicit") return;
		assert.strictEqual(snapshot.validatedHeadSha, head);
		assert.strictEqual(snapshot.destinationBaselineSha, fixture.baseline);
		assert.strictEqual(snapshot.destinationRef, fixture.destinationRef);
		assert.deepStrictEqual(snapshot.outgoingShas, [head]);
	}
});

test("U-DI-16 | targeted discovery fails closed when the destination diverged", async (t) => {
	const fixture = createTargetFixture();
	t.after(() => disposeTargetFixture(fixture));
	fixture.repo.checkoutDetached();
	const head = commitOnHead(fixture, "task.ts");
	const concurrent = moveRemoteDestination(fixture);
	await assert.rejects(
		runDiscovery(settingsFor(fixture), targetedScope(fixture)),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /diverged/u);
			assert.match(error.message, new RegExp(concurrent));
			assert.match(error.message, /outside git-commits-push/u);
			return true;
		},
	);
	assert.strictEqual(
		git(fixture.remotePath, ["rev-parse", fixture.branch]),
		concurrent,
	);
	assert.strictEqual(git(fixture.repo.dir, ["rev-parse", "HEAD"]), head);
});
