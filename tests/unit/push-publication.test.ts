import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import { PushError } from "../../src/modules/core/errors.ts";
import {
	executePush,
	publishWithFrozenEndpoint,
} from "../../src/modules/git/push.ts";
import type { ResolvedPushEndpoint } from "../../src/modules/git/push-endpoint.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";

interface PushPublicationFixture {
	readonly baselineSha: string;
	readonly branch: string;
	readonly fetchRemotePath: string;
	readonly pushRemotePath: string;
	readonly remoteRoot: string;
	readonly repository: GitRepoFixture;
}

const cleanup: Array<() => void> = [];

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

function initializeBareRemote(remotePath: string): void {
	execFileSync("git", ["init", "--bare", remotePath]);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function createPushPublicationFixture(): PushPublicationFixture {
	const remoteRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "push-publication-"),
	);
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
		baselineSha,
		branch,
		fetchRemotePath,
		pushRemotePath,
		remoteRoot,
		repository,
	};
}

function addCommit(fixture: PushPublicationFixture): string {
	fixture.repository.writeAndStage(
		"publication.ts",
		"export const publication = true;\n",
	);
	fixture.repository.commit("add publication");
	return git(fixture.repository.dir, ["rev-parse", "HEAD"]);
}

afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
});

describe("normal push publication", () => {
	test("recognizes an uncertain first push that already published the exact SHA", () => {
		const baselineSha = "a".repeat(40);
		const sourceSha = "b".repeat(40);
		let remoteSha = baselineSha;
		let pushCount = 0;
		const endpoint: ResolvedPushEndpoint = {
			fingerprint: "test-endpoint",
			readDestinationSha: () => remoteSha,
			readOptionalDestinationSha: () => remoteSha,
			pushExact: () => {
				pushCount++;
				remoteSha = sourceSha;
				throw new Error("connection reset after publication");
			},
		};

		assert.strictEqual(
			publishWithFrozenEndpoint(
				endpoint,
				"refs/heads/main",
				baselineSha,
				sourceSha,
			),
			1,
		);
		assert.strictEqual(pushCount, 1);
	});

	test("reuses the exact source, destination, and lease on retry", () => {
		const baselineSha = "c".repeat(40);
		const sourceSha = "d".repeat(40);
		const destinationRef = "refs/heads/main";
		const calls: Array<[string, string, string | null]> = [];
		const endpoint: ResolvedPushEndpoint = {
			fingerprint: "test-endpoint",
			readDestinationSha: () => baselineSha,
			readOptionalDestinationSha: () => baselineSha,
			pushExact: (source, destination, baseline) => {
				calls.push([source, destination, baseline]);
				if (calls.length === 1) throw new Error("temporary transport failure");
			},
		};

		assert.strictEqual(
			publishWithFrozenEndpoint(
				endpoint,
				destinationRef,
				baselineSha,
				sourceSha,
			),
			1,
		);
		assert.deepStrictEqual(calls, [
			[sourceSha, destinationRef, baselineSha],
			[sourceSha, destinationRef, baselineSha],
		]);
	});

	test("publishes and verifies the exact HEAD at the effective push endpoint", () => {
		const fixture = createPushPublicationFixture();
		const expectedHead = addCommit(fixture);

		executePush(fixture.repository.dir, true);

		assert.strictEqual(
			git(fixture.pushRemotePath, ["rev-parse", fixture.branch]),
			expectedHead,
		);
		assert.strictEqual(
			git(fixture.fetchRemotePath, ["rev-parse", fixture.branch]),
			fixture.baselineSha,
		);
	});

	test("rejects multiple effective push URLs before publishing", () => {
		const fixture = createPushPublicationFixture();
		const secondPushRemotePath = path.join(
			fixture.remoteRoot,
			"second-push.git",
		);
		initializeBareRemote(secondPushRemotePath);
		git(fixture.repository.dir, [
			"push",
			secondPushRemotePath,
			`${fixture.baselineSha}:refs/heads/${fixture.branch}`,
		]);
		git(fixture.repository.dir, [
			"remote",
			"set-url",
			"--add",
			"--push",
			"origin",
			secondPushRemotePath,
		]);
		addCommit(fixture);

		assert.throws(
			() => executePush(fixture.repository.dir, true),
			(error) => {
				assert.ok(error instanceof PushError);
				assert.strictEqual(error.transient, false);
				assert.match(error.message, /exactly one push URL/u);
				return true;
			},
		);
		for (const remotePath of [fixture.pushRemotePath, secondPushRemotePath]) {
			assert.strictEqual(
				git(remotePath, ["rev-parse", fixture.branch]),
				fixture.baselineSha,
			);
		}
	});

	test("retries a transient rejection against the originally frozen endpoint", () => {
		const fixture = createPushPublicationFixture();
		const secondPushRemotePath = path.join(fixture.remoteRoot, "redirect.git");
		initializeBareRemote(secondPushRemotePath);
		git(fixture.repository.dir, [
			"push",
			secondPushRemotePath,
			`${fixture.baselineSha}:refs/heads/${fixture.branch}`,
		]);
		const rejectionMarker = path.join(fixture.remoteRoot, "rejected-once");
		const hookPath = path.join(fixture.pushRemotePath, "hooks", "pre-receive");
		fs.writeFileSync(
			hookPath,
			[
				"#!/bin/sh",
				`if [ ! -e ${shellQuote(rejectionMarker)} ]; then`,
				`  : > ${shellQuote(rejectionMarker)}`,
				`  unset GIT_DIR GIT_WORK_TREE; git -C ${shellQuote(fixture.repository.dir)} remote set-url --push origin ${shellQuote(secondPushRemotePath)}`,
				"  echo 'temporary rejection' >&2",
				"  exit 1",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		fs.chmodSync(hookPath, 0o755);
		const expectedHead = addCommit(fixture);

		const retryCount = executePush(fixture.repository.dir, true);

		assert.strictEqual(retryCount, 1);
		assert.strictEqual(
			git(fixture.pushRemotePath, ["rev-parse", fixture.branch]),
			expectedHead,
		);
		assert.strictEqual(
			git(secondPushRemotePath, ["rev-parse", fixture.branch]),
			fixture.baselineSha,
		);
	});
});
