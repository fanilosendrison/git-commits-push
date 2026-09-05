import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import { executePush } from "../../src/modules/git/push.ts";
import {
	captureTrackedPushSnapshot,
	validateAndPushTrackedSnapshot,
} from "../../src/modules/git/push-only.ts";
import type { Settings } from "../../src/types.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";

const SETTINGS: Settings = {
	searchPaths: [],
	provider: "mistral",
	model: "mistral-medium-3.5",
	temperature: 0,
	systemPromptPath: "/dev/null",
	autoPush: true,
	skipTests: true,
};
const cleanup: Array<() => void> = [];

interface DistinctEndpointFixture {
	repository: GitRepoFixture;
	fetchRemotePath: string;
	pushRemotePath: string;
	remoteRoot: string;
	branch: string;
	baselineSha: string;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initializeBareRemote(remotePath: string): void {
	execFileSync("git", ["init", "--bare", remotePath]);
}

function createDistinctEndpointFixture(): DistinctEndpointFixture {
	const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "push-endpoint-"));
	const fetchRemotePath = path.join(remoteRoot, "fetch.git");
	const pushRemotePath = path.join(remoteRoot, "push.git");
	initializeBareRemote(fetchRemotePath);
	initializeBareRemote(pushRemotePath);
	const repository = GitRepoFixture.create();
	repository.commit("initial");
	repository.setRemote("origin", fetchRemotePath);
	const branch = git(repository.dir, [
		"symbolic-ref",
		"--quiet",
		"--short",
		"HEAD",
	]);
	git(repository.dir, ["push", "--set-upstream", "origin", branch]);
	const baselineSha = git(repository.dir, ["rev-parse", "HEAD"]);
	git(repository.dir, [
		"push",
		pushRemotePath,
		`${baselineSha}:refs/heads/${branch}`,
	]);
	git(repository.dir, [
		"remote",
		"set-url",
		"--push",
		"origin",
		pushRemotePath,
	]);
	cleanup.push(() => {
		repository.dispose();
		fs.rmSync(remoteRoot, { recursive: true, force: true });
	});
	return {
		repository,
		fetchRemotePath,
		pushRemotePath,
		remoteRoot,
		branch,
		baselineSha,
	};
}

function addConfiguredRemote(
	fixture: DistinctEndpointFixture,
	remoteName: string,
): string {
	const remotePath = path.join(fixture.remoteRoot, `${remoteName}.git`);
	initializeBareRemote(remotePath);
	git(fixture.repository.dir, ["remote", "add", remoteName, remotePath]);
	git(fixture.repository.dir, [
		"push",
		remoteName,
		`${fixture.baselineSha}:refs/heads/${fixture.branch}`,
	]);
	return remotePath;
}

function addAheadCommit(fixture: DistinctEndpointFixture): string {
	fixture.repository.writeAndStage("ahead.ts", "export const ahead = true;\n");
	fixture.repository.commit("add ahead commit");
	return git(fixture.repository.dir, ["rev-parse", "HEAD"]);
}

async function passingScanner() {
	return { hasSecrets: false, matchCount: 0 };
}

afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
});

describe("push-only endpoint consistency", () => {
	test("pins chained URL rewrites to one endpoint", async () => {
		const fixture = createDistinctEndpointFixture();
		const rewrittenFetchRoot = path.join(fixture.remoteRoot, "rewritten-fetch");
		const rewrittenPushRoot = path.join(fixture.remoteRoot, "rewritten-push");
		fs.mkdirSync(rewrittenFetchRoot);
		fs.mkdirSync(rewrittenPushRoot);
		const rewrittenFetchPath = path.join(rewrittenFetchRoot, "repo.git");
		const rewrittenPushPath = path.join(rewrittenPushRoot, "repo.git");
		initializeBareRemote(rewrittenFetchPath);
		initializeBareRemote(rewrittenPushPath);
		for (const remotePath of [rewrittenFetchPath, rewrittenPushPath]) {
			git(fixture.repository.dir, [
				"push",
				remotePath,
				`${fixture.baselineSha}:refs/heads/${fixture.branch}`,
			]);
		}
		git(fixture.repository.dir, [
			"config",
			`url.${rewrittenFetchRoot}${path.sep}.insteadOf`,
			"gcp-alias://",
		]);
		git(fixture.repository.dir, [
			"config",
			`url.${rewrittenPushRoot}${path.sep}.pushInsteadOf`,
			`${rewrittenFetchRoot}${path.sep}`,
		]);
		git(fixture.repository.dir, [
			"remote",
			"set-url",
			"--push",
			"--delete",
			"origin",
			fixture.pushRemotePath,
		]);
		git(fixture.repository.dir, [
			"remote",
			"set-url",
			"origin",
			"gcp-alias://repo.git",
		]);
		const expectedHead = addAheadCommit(fixture);
		const snapshot = captureTrackedPushSnapshot(fixture.repository.dir);
		assert.ok(snapshot);

		await validateAndPushTrackedSnapshot(
			{ id: "repo", path: fixture.repository.dir },
			snapshot,
			SETTINGS,
			passingScanner,
		);

		assert.strictEqual(
			git(rewrittenFetchPath, ["rev-parse", fixture.branch]),
			expectedHead,
		);
		assert.strictEqual(
			git(rewrittenPushPath, ["rev-parse", fixture.branch]),
			fixture.baselineSha,
		);
	});

	test("rejects rewrite-chain changes after snapshot capture", async () => {
		const fixture = createDistinctEndpointFixture();
		const resolvedRoot = path.join(fixture.remoteRoot, "resolved");
		const replacementRoot = path.join(fixture.remoteRoot, "replacement");
		fs.mkdirSync(resolvedRoot);
		fs.mkdirSync(replacementRoot);
		const resolvedPath = path.join(resolvedRoot, "repo.git");
		const replacementPath = path.join(replacementRoot, "repo.git");
		initializeBareRemote(resolvedPath);
		initializeBareRemote(replacementPath);
		for (const remotePath of [resolvedPath, replacementPath]) {
			git(fixture.repository.dir, [
				"push",
				remotePath,
				`${fixture.baselineSha}:refs/heads/${fixture.branch}`,
			]);
		}
		git(fixture.repository.dir, [
			"config",
			`url.${resolvedRoot}${path.sep}.insteadOf`,
			"gcp-chain://",
		]);
		git(fixture.repository.dir, [
			"remote",
			"set-url",
			"--push",
			"origin",
			"gcp-chain://repo.git",
		]);
		addAheadCommit(fixture);
		const snapshot = captureTrackedPushSnapshot(fixture.repository.dir);
		assert.ok(snapshot);

		git(fixture.repository.dir, [
			"config",
			`url.${replacementRoot}${path.sep}.insteadOf`,
			`${resolvedRoot}${path.sep}`,
		]);
		await assert.rejects(
			validateAndPushTrackedSnapshot(
				{ id: "repo", path: fixture.repository.dir },
				snapshot,
				SETTINGS,
				passingScanner,
			),
			/remote push URL changed/iu,
		);
		assert.strictEqual(
			git(resolvedPath, ["rev-parse", fixture.branch]),
			fixture.baselineSha,
		);
		assert.strictEqual(
			git(replacementPath, ["rev-parse", fixture.branch]),
			fixture.baselineSha,
		);
	});

	test("queries and pushes the single configured push URL, not the fetch URL", async () => {
		const fixture = createDistinctEndpointFixture();
		const expectedHead = addAheadCommit(fixture);
		const snapshot = captureTrackedPushSnapshot(fixture.repository.dir);
		assert.ok(snapshot);
		assert.match(snapshot.pushUrlFingerprint, /^[a-f0-9]{64}$/u);

		await validateAndPushTrackedSnapshot(
			{ id: "repo", path: fixture.repository.dir },
			snapshot,
			SETTINGS,
			passingScanner,
		);

		assert.strictEqual(
			git(fixture.pushRemotePath, ["rev-parse", fixture.branch]),
			expectedHead,
		);
		assert.strictEqual(
			git(fixture.fetchRemotePath, ["rev-parse", fixture.branch]),
			fixture.baselineSha,
		);
	});

	test("honors branch pushRemote before the upstream remote", async () => {
		const fixture = createDistinctEndpointFixture();
		const publishRemotePath = addConfiguredRemote(fixture, "publish");
		git(fixture.repository.dir, [
			"config",
			`branch.${fixture.branch}.pushRemote`,
			"publish",
		]);
		const expectedHead = addAheadCommit(fixture);
		const snapshot = captureTrackedPushSnapshot(fixture.repository.dir);
		assert.ok(snapshot);
		assert.strictEqual(snapshot.remote, "publish");

		await validateAndPushTrackedSnapshot(
			{ id: "repo", path: fixture.repository.dir },
			snapshot,
			SETTINGS,
			passingScanner,
		);

		assert.strictEqual(
			git(publishRemotePath, ["rev-parse", fixture.branch]),
			expectedHead,
		);
		assert.strictEqual(
			git(fixture.fetchRemotePath, ["rev-parse", fixture.branch]),
			fixture.baselineSha,
		);
	});

	test("honors remote.pushDefault when branch.pushRemote is absent", async () => {
		const fixture = createDistinctEndpointFixture();
		const publishRemotePath = addConfiguredRemote(fixture, "default-publish");
		git(fixture.repository.dir, [
			"config",
			"remote.pushDefault",
			"default-publish",
		]);
		const expectedHead = addAheadCommit(fixture);
		const snapshot = captureTrackedPushSnapshot(fixture.repository.dir);
		assert.ok(snapshot);
		assert.strictEqual(snapshot.remote, "default-publish");

		await validateAndPushTrackedSnapshot(
			{ id: "repo", path: fixture.repository.dir },
			snapshot,
			SETTINGS,
			passingScanner,
		);

		assert.strictEqual(
			git(publishRemotePath, ["rev-parse", fixture.branch]),
			expectedHead,
		);
		assert.strictEqual(
			git(fixture.fetchRemotePath, ["rev-parse", fixture.branch]),
			fixture.baselineSha,
		);
	});

	test("treats an option-shaped remote name as an operand", () => {
		const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "push-option-"));
		const remotePath = path.join(remoteRoot, "remote.git");
		initializeBareRemote(remotePath);
		const repository = GitRepoFixture.create();
		repository.commit("initial");
		git(repository.dir, ["remote", "add", "--", "--all", remotePath]);
		cleanup.push(() => {
			repository.dispose();
			fs.rmSync(remoteRoot, { recursive: true, force: true });
		});
		const branch = git(repository.dir, [
			"symbolic-ref",
			"--quiet",
			"--short",
			"HEAD",
		]);
		const expectedHead = git(repository.dir, ["rev-parse", "HEAD"]);

		executePush(repository.dir, true);

		assert.strictEqual(git(remotePath, ["rev-parse", branch]), expectedHead);
	});

	test("rejects a tracked remote with multiple effective push URLs", () => {
		const fixture = createDistinctEndpointFixture();
		const secondPushRemote = path.join(fixture.remoteRoot, "second-push.git");
		initializeBareRemote(secondPushRemote);
		git(fixture.repository.dir, [
			"remote",
			"set-url",
			"--add",
			"--push",
			"origin",
			secondPushRemote,
		]);
		addAheadCommit(fixture);

		assert.throws(
			() => captureTrackedPushSnapshot(fixture.repository.dir),
			/exactly one push URL/u,
		);
	});

	test("rejects a push URL changed after snapshot capture", async () => {
		const fixture = createDistinctEndpointFixture();
		addAheadCommit(fixture);
		const snapshot = captureTrackedPushSnapshot(fixture.repository.dir);
		assert.ok(snapshot);
		const replacementPushRemote = path.join(
			fixture.remoteRoot,
			"replacement-push.git",
		);
		initializeBareRemote(replacementPushRemote);
		git(fixture.repository.dir, [
			"push",
			replacementPushRemote,
			`${fixture.baselineSha}:refs/heads/${fixture.branch}`,
		]);
		git(fixture.repository.dir, [
			"remote",
			"set-url",
			"--push",
			"origin",
			replacementPushRemote,
		]);

		await assert.rejects(
			validateAndPushTrackedSnapshot(
				{ id: "repo", path: fixture.repository.dir },
				snapshot,
				SETTINGS,
				passingScanner,
			),
			/push URL changed/u,
		);
		assert.strictEqual(
			git(replacementPushRemote, ["rev-parse", fixture.branch]),
			fixture.baselineSha,
		);
	});
});
