import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import { executePush } from "../../src/modules/git/push.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";

const cleanup: Array<() => void> = [];

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

function initializeBareRemote(remotePath: string): void {
	execFileSync("git", ["init", "--bare", remotePath]);
}

afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
});

describe("push destination resolution", () => {
	test("pushes the current branch name in a triangular workflow", () => {
		const remoteRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "push-triangular-"),
		);
		const originPath = path.join(remoteRoot, "origin.git");
		const publishPath = path.join(remoteRoot, "publish.git");
		initializeBareRemote(originPath);
		initializeBareRemote(publishPath);
		const repository = GitRepoFixture.create();
		cleanup.push(() => {
			repository.dispose();
			fs.rmSync(remoteRoot, { recursive: true, force: true });
		});
		repository.commit("baseline");
		repository.setRemote("origin", originPath);
		git(repository.dir, ["remote", "add", "publish", publishPath]);
		git(repository.dir, ["push", "--set-upstream", "origin", "HEAD:main"]);
		git(repository.dir, ["branch", "-m", "topic"]);
		const baselineSha = git(repository.dir, ["rev-parse", "HEAD"]);
		for (const destinationRef of ["refs/heads/main", "refs/heads/topic"]) {
			git(repository.dir, [
				"push",
				"publish",
				`${baselineSha}:${destinationRef}`,
			]);
		}
		git(repository.dir, ["config", "branch.topic.pushRemote", "publish"]);
		repository.writeAndStage(
			"triangular.ts",
			"export const triangular = true;\n",
		);
		repository.commit("add triangular change");
		const expectedHead = git(repository.dir, ["rev-parse", "HEAD"]);

		executePush(repository.dir, true);

		assert.strictEqual(
			git(publishPath, ["rev-parse", "refs/heads/topic"]),
			expectedHead,
		);
		assert.strictEqual(
			git(publishPath, ["rev-parse", "refs/heads/main"]),
			baselineSha,
		);
		assert.strictEqual(
			git(originPath, ["rev-parse", "refs/heads/main"]),
			baselineSha,
		);
	});

	test("rejects push.default=simple when source and central upstream names differ", () => {
		const remoteRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "push-simple-name-mismatch-"),
		);
		const originPath = path.join(remoteRoot, "origin.git");
		initializeBareRemote(originPath);
		const repository = GitRepoFixture.create();
		cleanup.push(() => {
			repository.dispose();
			fs.rmSync(remoteRoot, { recursive: true, force: true });
		});
		repository.commit("baseline");
		repository.setRemote("origin", originPath);
		git(repository.dir, ["push", "--set-upstream", "origin", "HEAD:main"]);
		git(repository.dir, ["branch", "-m", "topic"]);
		repository.writeAndStage("mismatch.ts", "export const mismatch = true;\n");
		repository.commit("add mismatched branch change");

		assert.throws(
			() => executePush(repository.dir, true),
			(error) => {
				assert.match(String(error), /push\.default=simple/u);
				return true;
			},
		);
		assert.strictEqual(
			git(originPath, ["rev-parse", "refs/heads/main"]),
			git(repository.dir, ["rev-parse", "HEAD^"]),
		);
	});
});
