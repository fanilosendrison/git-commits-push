import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import { classifyError } from "../../src/modules/core/error-classifier.ts";
import {
	PostCommitPushError,
	PushError,
} from "../../src/modules/core/errors.ts";
import { executeMultiCommitAndPush } from "../../src/modules/git/publisher.ts";
import { classifyTransient } from "../../src/modules/git/push.ts";
import {
	captureTrackedPushSnapshot,
	validateAndPushTrackedSnapshot,
} from "../../src/modules/git/push-only.ts";
import { mergePostCommitPushFailure } from "../../src/phases/step2-commit-push.ts";
import type { CommitPlan, Settings } from "../../src/types.ts";
import { extractDiff } from "../../src/utils/git-utils.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";

const SETTINGS: Settings = {
	searchPaths: [],
	provider: "deepseek",
	model: "deepseek-v4-flash",
	temperature: 0,
	systemPromptPath: "/dev/null",
	autoPush: true,
	skipTests: true,
};

const cleanup: Array<() => void> = [];

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

function createTrackedRepository(): {
	readonly baselineSha: string;
	readonly branch: string;
	readonly remotePath: string;
	readonly repository: GitRepoFixture;
} {
	const remotePath = fs.mkdtempSync(
		path.join(os.tmpdir(), "post-commit-push-"),
	);
	git(remotePath, ["init", "--bare"]);
	const repository = GitRepoFixture.create();
	repository.commit("initial");
	repository.setRemote("origin", remotePath);
	const branch = git(repository.dir, [
		"symbolic-ref",
		"--quiet",
		"--short",
		"HEAD",
	]);
	git(repository.dir, ["push", "--set-upstream", "origin", branch]);
	const baselineSha = git(repository.dir, ["rev-parse", "HEAD"]);
	cleanup.push(() => {
		repository.dispose();
		fs.rmSync(remotePath, { recursive: true, force: true });
	});
	return { baselineSha, branch, remotePath, repository };
}

afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
});

describe("post-commit push recovery", () => {
	test("exhausted transient push preserves landed commits for push-only recovery", async () => {
		const fixture = createTrackedRepository();
		const hookPath = path.join(fixture.remotePath, "hooks", "pre-receive");
		const attemptLog = path.join(fixture.remotePath, "push-attempts");
		fs.writeFileSync(
			hookPath,
			`#!/bin/sh\necho attempt >> ${JSON.stringify(attemptLog)}\necho 'temporary rejection' >&2\nexit 1\n`,
		);
		fs.chmodSync(hookPath, 0o755);
		fixture.repository.writeAndStage(
			"recovery.ts",
			"export const recovery = true;\n",
		);
		const { diffHash } = await extractDiff(fixture.repository.dir);
		const plans: CommitPlan[] = [
			{
				commit: {
					type: "fix",
					description: "preserve committed push recovery",
					isBreaking: false,
				},
				files: ["recovery.ts"],
			},
		];

		let caught: unknown;
		try {
			await executeMultiCommitAndPush(
				fixture.repository.dir,
				plans,
				diffHash,
				SETTINGS,
			);
		} catch (error) {
			caught = error;
		}

		assert.ok(caught instanceof PostCommitPushError);
		if (!(caught instanceof PostCommitPushError)) return;
		assert.strictEqual(caught.context.committedShas.length, 1);
		assert.strictEqual(caught.context.originalHead, fixture.baselineSha);
		assert.strictEqual(caught.context.pushRetryCount, 1);
		assert.strictEqual(
			git(fixture.repository.dir, ["rev-list", "--count", "HEAD"]),
			"2",
		);
		assert.strictEqual(
			fs.readFileSync(attemptLog, "utf8").trim().split("\n").length,
			2,
		);
		assert.deepStrictEqual(classifyError(caught, true), {
			kind: "fail",
			error: { kind: "network", message: caught.message },
		});

		fs.writeFileSync(hookPath, "#!/bin/sh\nexit 0\n");
		const snapshot = captureTrackedPushSnapshot(fixture.repository.dir);
		assert.ok(snapshot);
		if (!snapshot) return;
		const pushedShas = await validateAndPushTrackedSnapshot(
			{
				id: "repository",
				path: fixture.repository.dir,
				operation: "push-only",
			},
			snapshot,
			SETTINGS,
		);
		assert.deepStrictEqual(pushedShas, snapshot.outgoingShas);
		assert.strictEqual(
			git(fixture.remotePath, ["rev-parse", fixture.branch]),
			git(fixture.repository.dir, ["rev-parse", "HEAD"]),
		);
	});

	test("preserves the oldest head and de-duplicates phase state", () => {
		const duplicate = { sha: "a".repeat(40), files: ["first.ts"] };
		const landed = { sha: "b".repeat(40), files: ["second.ts"] };
		const error = new PostCommitPushError(
			new PushError("publication failed", true, 1),
			{
				committedShas: [duplicate, landed],
				originalHead: "newer-head",
				pushRetryCount: 1,
			},
		);

		const merged = mergePostCommitPushFailure(
			{
				repository: "/repository",
				status: "RUNNING",
				committedShas: [duplicate],
				originalHead: "oldest-head",
				attempts: { network: 2 },
			},
			error,
		);

		assert.strictEqual(merged.originalHead, "oldest-head");
		assert.deepStrictEqual(merged.committedShas, [duplicate, landed]);
		assert.strictEqual(merged.attempts?.network, 3);
	});

	test("non-interactive HTTPS credential failures are permanent", () => {
		assert.strictEqual(
			classifyTransient(
				"fatal: could not read Username for 'https://github.com': terminal prompts disabled",
			),
			false,
		);
	});
});
