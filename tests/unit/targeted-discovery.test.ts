// tests/unit/targeted-discovery.test.ts — Unit tests for exact-worktree
// discovery under a targeted invocation scope.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { runDiscovery } from "../../src/modules/core/discovery.ts";
import { resolveInvocationScope } from "../../src/modules/invocation/invocation-scope.ts";
import type { InvocationScope, Settings } from "../../src/types.ts";
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

describe("U-DI-12 | targeted discovery — detached dirty target included", () => {
	let repo: GitRepoFixture;
	let remoteRoot: string;
	let targetScope: InvocationScope;

	before(() => {
		remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-12-remote-"));
		const remotePath = path.join(remoteRoot, "remote.git");
		execFileSync("git", ["init", "--bare", remotePath]);
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.setRemote("origin", remotePath);
		repo.checkoutDetached();
		repo.writeAndStage("detached-change.ts", "export const detached = true;\n");
		targetScope = resolveInvocationScope({
			kind: "targeted",
			repository: repo.dir,
			pushRemote: "origin",
			pushRef: "refs/heads/main",
		});
	});
	after(() => {
		repo.dispose();
		fs.rmSync(remoteRoot, { recursive: true, force: true });
	});

	test("returns the detached dirty worktree as commit-and-push", async () => {
		const results = await runDiscovery(
			{ ...BASE_SETTINGS, autoPush: false, searchPaths: [repo.dir] },
			targetScope,
		);

		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0]?.path, fs.realpathSync(repo.dir));
		assert.strictEqual(results[0]?.operation, "commit-and-push");
	});
});

describe("U-DI-13 | targeted discovery ignores broad searchPaths", () => {
	let searchRoot: string;
	let remoteRoot: string;
	let target: GitRepoFixture;
	let unrelated: GitRepoFixture;
	let targetScope: InvocationScope;

	before(() => {
		searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-13-"));
		remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-13-remote-"));
		const remotePath = path.join(remoteRoot, "remote.git");
		execFileSync("git", ["init", "--bare", remotePath]);

		target = GitRepoFixture.create({ parentDir: searchRoot });
		target.commit("initial");
		target.setRemote("origin", remotePath);
		target.writeAndStage("target-change.ts", "export const target = true;\n");

		unrelated = GitRepoFixture.create({ parentDir: searchRoot });
		unrelated.commit("initial");
		unrelated.writeAndStage(
			"unrelated-change.ts",
			"export const unrelated = true;\n",
		);

		targetScope = resolveInvocationScope({
			kind: "targeted",
			repository: target.dir,
			pushRemote: "origin",
			pushRef: "refs/heads/main",
		});
	});
	after(() => {
		target.dispose();
		unrelated.dispose();
		fs.rmSync(searchRoot, { recursive: true, force: true });
		fs.rmSync(remoteRoot, { recursive: true, force: true });
	});

	test("scans only the targeted repository", async () => {
		const results = await runDiscovery(
			{ ...BASE_SETTINGS, autoPush: false, searchPaths: [searchRoot] },
			targetScope,
		);

		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0]?.path, fs.realpathSync(target.dir));
		assert.strictEqual(
			results.some((result) => result.path === fs.realpathSync(unrelated.dir)),
			false,
		);
	});
});

describe("U-DI-14 | targeted discovery isolates linked worktrees", () => {
	let root: string;
	let remoteRoot: string;
	let persistent: GitRepoFixture;
	let targetPath: string;
	let siblingPath: string;
	let targetScope: InvocationScope;

	before(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "di-14-"));
		remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-14-remote-"));
		const remotePath = path.join(remoteRoot, "remote.git");
		execFileSync("git", ["init", "--bare", remotePath]);

		persistent = GitRepoFixture.create({ parentDir: root });
		persistent.commit("initial");
		persistent.setRemote("origin", remotePath);

		targetPath = path.join(root, "target-worktree");
		siblingPath = path.join(root, "sibling-worktree");
		execFileSync(
			"git",
			[
				"-C",
				persistent.dir,
				"worktree",
				"add",
				targetPath,
				"-b",
				"target-branch",
			],
			{ stdio: "pipe" },
		);
		execFileSync(
			"git",
			[
				"-C",
				persistent.dir,
				"worktree",
				"add",
				siblingPath,
				"-b",
				"sibling-branch",
			],
			{ stdio: "pipe" },
		);

		persistent.writeAndStage(
			"persistent-change.ts",
			"export const persistent = true;\n",
		);
		fs.writeFileSync(
			path.join(targetPath, "target-change.ts"),
			"export const target = true;\n",
		);
		execFileSync("git", ["-C", targetPath, "add", "-A"], { stdio: "pipe" });
		fs.writeFileSync(
			path.join(siblingPath, "sibling-change.ts"),
			"export const sibling = true;\n",
		);
		execFileSync("git", ["-C", siblingPath, "add", "-A"], { stdio: "pipe" });

		targetScope = resolveInvocationScope({
			kind: "targeted",
			repository: targetPath,
			pushRemote: "origin",
			pushRef: "refs/heads/target-branch",
		});
	});
	after(() => {
		persistent.dispose();
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(remoteRoot, { recursive: true, force: true });
	});

	test("returns only the targeted linked worktree", async () => {
		const canonicalTarget = fs.realpathSync(targetPath);
		const results = await runDiscovery(
			{ ...BASE_SETTINGS, autoPush: false, searchPaths: [root] },
			targetScope,
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
});

describe("U-DI-15 | targeted clean result is independent of autoPush", () => {
	let repo: GitRepoFixture;
	let remoteRoot: string;
	let targetScope: InvocationScope;

	before(() => {
		remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "di-15-remote-"));
		const remotePath = path.join(remoteRoot, "remote.git");
		execFileSync("git", ["init", "--bare", remotePath]);
		repo = GitRepoFixture.create();
		repo.commit("initial");
		repo.setRemote("origin", remotePath);
		targetScope = resolveInvocationScope({
			kind: "targeted",
			repository: repo.dir,
			pushRemote: "origin",
			pushRef: "refs/heads/main",
		});
	});
	after(() => {
		repo.dispose();
		fs.rmSync(remoteRoot, { recursive: true, force: true });
	});

	// Explicit-target clean push-only semantics are deferred to the
	// explicit-target publication implementation; autoPush is a global-mode
	// policy and is not a targeted authority.
	test("returns no work for a clean target regardless of autoPush", async () => {
		const disabled = await runDiscovery(
			{ ...BASE_SETTINGS, autoPush: false, searchPaths: [repo.dir] },
			targetScope,
		);
		const enabled = await runDiscovery(
			{ ...BASE_SETTINGS, autoPush: true, searchPaths: [repo.dir] },
			targetScope,
		);

		assert.deepStrictEqual(disabled, []);
		assert.deepStrictEqual(enabled, []);
	});
});
