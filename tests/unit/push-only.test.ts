import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
	captureTrackedPushSnapshot,
	validateAndPushTrackedSnapshot,
} from "../../src/modules/git/push-only.ts";
import { handlePushOnlyCheckpointResult } from "../../src/modules/git/push-only-checkpoint.ts";
import type { Settings } from "../../src/types.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";

interface TrackedFixture {
	repository: GitRepoFixture;
	remoteRoot: string;
	remotePath: string;
	branch: string;
	baselineSha: string;
}

const cleanup: Array<() => void> = [];
const SETTINGS: Settings = {
	searchPaths: [],
	provider: "mistral",
	model: "mistral-medium-3.5",
	temperature: 0,
	systemPromptPath: "/dev/null",
	autoPush: true,
	skipTests: true,
};

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createTrackedFixture(): TrackedFixture {
	const remoteRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "push-only-remote-"),
	);
	const remotePath = path.join(remoteRoot, "remote.git");
	execFileSync("git", ["init", "--bare", remotePath]);
	const repository = GitRepoFixture.create();
	repository.commit("initial");
	repository.setRemote("origin", remotePath);
	const branch = git(repository.dir, [
		"symbolic-ref",
		"--quiet",
		"--short",
		"HEAD",
	]);
	execFileSync("git", ["push", "--set-upstream", "origin", branch], {
		cwd: repository.dir,
	});
	const baselineSha = git(repository.dir, ["rev-parse", "HEAD"]);
	cleanup.push(() => {
		repository.dispose();
		fs.rmSync(remoteRoot, { recursive: true, force: true });
	});
	return { repository, remoteRoot, remotePath, branch, baselineSha };
}

function addCommit(
	repository: GitRepoFixture,
	filename: string,
	content: string,
): string {
	repository.writeAndStage(filename, content);
	repository.commit(`add ${filename}`);
	return git(repository.dir, ["rev-parse", "HEAD"]);
}

function advanceRemote(fixture: TrackedFixture): string {
	const cloneRoot = fs.mkdtempSync(path.join(os.tmpdir(), "push-only-clone-"));
	try {
		const clonePath = path.join(cloneRoot, "clone");
		execFileSync("git", ["clone", fixture.remotePath, clonePath]);
		git(clonePath, ["config", "user.email", "test@example.com"]);
		git(clonePath, ["config", "user.name", "Test"]);
		fs.writeFileSync(
			path.join(clonePath, "concurrent.ts"),
			"export const concurrent = true;\n",
		);
		git(clonePath, ["add", "concurrent.ts"]);
		git(clonePath, ["commit", "--no-verify", "-m", "add concurrent commit"]);
		git(clonePath, ["push", "origin", fixture.branch]);
		return git(clonePath, ["rev-parse", "HEAD"]);
	} finally {
		fs.rmSync(cloneRoot, { recursive: true, force: true });
	}
}

async function passingScanner(diff: string) {
	return { hasSecrets: false, matchCount: 0, capturedDiff: diff };
}

afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
});

describe("tracked push-only snapshots", () => {
	test("captures ordered outgoing SHAs for a clean ahead branch", () => {
		const fixture = createTrackedFixture();
		const first = addCommit(
			fixture.repository,
			"first.ts",
			"export const first = 1;\n",
		);
		const second = addCommit(
			fixture.repository,
			"second.ts",
			"export const second = 2;\n",
		);

		const snapshot = captureTrackedPushSnapshot(fixture.repository.dir);
		assert.ok(snapshot);
		assert.deepStrictEqual(snapshot.outgoingShas, [first, second]);
		assert.strictEqual(snapshot.destinationBaselineSha, fixture.baselineSha);
		assert.strictEqual(snapshot.destinationRef, `refs/heads/${fixture.branch}`);
	});

	test("excludes synchronized, behind, and no-upstream branches", () => {
		const synchronized = createTrackedFixture();
		assert.strictEqual(
			captureTrackedPushSnapshot(synchronized.repository.dir),
			null,
		);

		const behind = createTrackedFixture();
		addCommit(behind.repository, "remote.ts", "export const remote = true;\n");
		execFileSync("git", ["push"], { cwd: behind.repository.dir });
		git(behind.repository.dir, ["reset", "--hard", "HEAD^"]);
		assert.strictEqual(captureTrackedPushSnapshot(behind.repository.dir), null);

		const untracked = GitRepoFixture.create();
		cleanup.push(() => untracked.dispose());
		untracked.commit("local only");
		assert.strictEqual(captureTrackedPushSnapshot(untracked.dir), null);

		const noRemote = GitRepoFixture.create();
		cleanup.push(() => noRemote.dispose());
		noRemote.commit("baseline");
		const noRemoteBranch = git(noRemote.dir, [
			"symbolic-ref",
			"--quiet",
			"--short",
			"HEAD",
		]);
		const noRemoteBaseline = git(noRemote.dir, ["rev-parse", "HEAD"]);
		git(noRemote.dir, [
			"update-ref",
			`refs/remotes/ghost/${noRemoteBranch}`,
			noRemoteBaseline,
		]);
		git(noRemote.dir, ["config", `branch.${noRemoteBranch}.remote`, "ghost"]);
		git(noRemote.dir, [
			"config",
			`branch.${noRemoteBranch}.merge`,
			`refs/heads/${noRemoteBranch}`,
		]);
		addCommit(noRemote, "ahead.ts", "export const ahead = true;\n");
		assert.strictEqual(captureTrackedPushSnapshot(noRemote.dir), null);
	});

	test("rejects a branch diverged from its configured upstream", () => {
		const fixture = createTrackedFixture();
		const localHead = addCommit(
			fixture.repository,
			"local.ts",
			"export const local = true;\n",
		);
		git(fixture.repository.dir, [
			"checkout",
			"-b",
			"sibling",
			fixture.baselineSha,
		]);
		const sibling = addCommit(
			fixture.repository,
			"sibling.ts",
			"export const sibling = true;\n",
		);
		git(fixture.repository.dir, ["checkout", fixture.branch]);
		assert.strictEqual(
			git(fixture.repository.dir, ["rev-parse", "HEAD"]),
			localHead,
		);
		git(fixture.repository.dir, [
			"push",
			"origin",
			`${sibling}:refs/heads/${fixture.branch}`,
		]);

		assert.throws(
			() => captureTrackedPushSnapshot(fixture.repository.dir),
			/diverged/u,
		);
	});
});

describe("tracked push-only publication", () => {
	test("scans every outgoing patch, pushes the exact HEAD, and is idempotent", async () => {
		const fixture = createTrackedFixture();
		addCommit(
			fixture.repository,
			"first.ts",
			"export const firstMarker = 1;\n",
		);
		const expectedHead = addCommit(
			fixture.repository,
			"second.ts",
			"export const secondMarker = 2;\n",
		);
		const snapshot = captureTrackedPushSnapshot(fixture.repository.dir);
		assert.ok(snapshot);
		let scannedDiff = "";
		const scanner = async (diff: string) => {
			scannedDiff = diff;
			return { hasSecrets: false, matchCount: 0 };
		};
		const repository = { id: "repo", path: fixture.repository.dir };

		await validateAndPushTrackedSnapshot(
			repository,
			snapshot,
			SETTINGS,
			scanner,
		);
		assert.match(scannedDiff, /firstMarker/u);
		assert.match(scannedDiff, /secondMarker/u);
		assert.strictEqual(
			git(fixture.remotePath, ["rev-parse", fixture.branch]),
			expectedHead,
		);
		await validateAndPushTrackedSnapshot(
			repository,
			snapshot,
			SETTINGS,
			scanner,
		);
	});

	test("rejects a persisted snapshot that omits an outgoing commit", async () => {
		const fixture = createTrackedFixture();
		addCommit(fixture.repository, "first.ts", "export const first = true;\n");
		addCommit(fixture.repository, "second.ts", "export const second = true;\n");
		const snapshot = captureTrackedPushSnapshot(fixture.repository.dir);
		assert.ok(snapshot);
		const incompleteSnapshot = {
			...snapshot,
			outgoingShas: snapshot.outgoingShas.slice(1),
		};

		await assert.rejects(
			validateAndPushTrackedSnapshot(
				{ id: "repo", path: fixture.repository.dir },
				incompleteSnapshot,
				SETTINGS,
				passingScanner,
			),
			/outgoing commit list/u,
		);
		assert.strictEqual(
			git(fixture.remotePath, ["rev-parse", fixture.branch]),
			fixture.baselineSha,
		);
	});

	test("blocks publication when the outgoing patch scanner reports a secret", async () => {
		const fixture = createTrackedFixture();
		addCommit(
			fixture.repository,
			"secret.ts",
			"export const credential = 'secret';\n",
		);
		const snapshot = captureTrackedPushSnapshot(fixture.repository.dir);
		assert.ok(snapshot);

		await assert.rejects(
			validateAndPushTrackedSnapshot(
				{ id: "repo", path: fixture.repository.dir },
				snapshot,
				SETTINGS,
				async () => ({
					hasSecrets: true,
					matchCount: 1,
					details: "test credential",
				}),
			),
			/Security Exception/u,
		);
		assert.strictEqual(
			git(fixture.remotePath, ["rev-parse", fixture.branch]),
			fixture.baselineSha,
		);
	});

	test("refuses a stale snapshot when the remote destination advances", async () => {
		const fixture = createTrackedFixture();
		addCommit(fixture.repository, "ahead.ts", "export const ahead = true;\n");
		const snapshot = captureTrackedPushSnapshot(fixture.repository.dir);
		assert.ok(snapshot);
		const concurrentHead = advanceRemote(fixture);

		await assert.rejects(
			validateAndPushTrackedSnapshot(
				{ id: "repo", path: fixture.repository.dir },
				snapshot,
				SETTINGS,
				passingScanner,
			),
			/Remote destination changed/u,
		);
		assert.strictEqual(
			git(fixture.remotePath, ["rev-parse", fixture.branch]),
			concurrentHead,
		);
	});

	test("fails a checkpoint explicitly if auto-push is disabled before resume", async () => {
		const fixture = createTrackedFixture();
		addCommit(fixture.repository, "ahead.ts", "export const ahead = true;\n");
		const snapshot = captureTrackedPushSnapshot(fixture.repository.dir);
		assert.ok(snapshot);

		const state = await handlePushOnlyCheckpointResult({
			repoId: "repo",
			repoState: {
				repository: fixture.repository.dir,
				status: "RUNNING",
				operation: "push-only",
				pushSnapshot: snapshot,
			},
			result: { success: true, id: "repo", commits: [] },
			runId: "run",
			settings: { ...SETTINGS, autoPush: false },
			skillLog: { logRepoOutcome() {} },
		});
		assert.strictEqual(state.status, "FAILED");
		assert.match(state.error ?? "", /autoPush is now disabled/u);
		assert.strictEqual(
			git(fixture.remotePath, ["rev-parse", fixture.branch]),
			fixture.baselineSha,
		);
	});

	test("refuses publication when the clean snapshot changes before push", async () => {
		const fixture = createTrackedFixture();
		addCommit(fixture.repository, "ahead.ts", "export const ahead = true;\n");
		const snapshot = captureTrackedPushSnapshot(fixture.repository.dir);
		assert.ok(snapshot);
		fs.writeFileSync(path.join(fixture.repository.dir, "late.txt"), "late\n");

		await assert.rejects(
			validateAndPushTrackedSnapshot(
				{ id: "repo", path: fixture.repository.dir },
				snapshot,
				SETTINGS,
				passingScanner,
			),
			/worktree changed/u,
		);
		assert.strictEqual(
			git(fixture.remotePath, ["rev-parse", fixture.branch]),
			fixture.baselineSha,
		);
	});
});
