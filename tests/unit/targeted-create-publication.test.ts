import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { runDiscovery } from "../../src/modules/core/discovery.ts";
import { processRepoValidationAndDiff } from "../../src/modules/core/validators/pre-commit-validators.ts";
import { handlePushOnlyCheckpointResult } from "../../src/modules/git/push-only-checkpoint.ts";
import {
	CREATE_SETTINGS,
	createFixture,
	git,
} from "../fixtures/targeted-create.ts";
import { executeMultiCommitAndPush } from "../fixtures/validated-publisher.ts";

for (const ahead of [false, true])
	test(`C${ahead ? "11" : "12"} | clean creation publishes exact HEAD without commits or LLM`, async () => {
		const f = createFixture();
		try {
			const head = ahead ? f.commit() : f.baseSha;
			const before = git(f.repo.dir, ["config", "--local", "--list"]);
			const refs = git(f.repo.dir, [
				"for-each-ref",
				"--format=%(refname) %(objectname)",
			]);
			const [repo] = await runDiscovery(CREATE_SETTINGS, f.scope());
			assert.ok(repo?.pushSnapshot);
			assert.equal(repo.pushSnapshot.kind, "explicit-create");
			assert.deepEqual(repo.pushSnapshot.outgoingShas, ahead ? [head] : []);
			const result = await handlePushOnlyCheckpointResult({
				repoId: repo.id,
				repoState: {
					repository: repo.path,
					status: "RUNNING",
					operation: "push-only",
					pushSnapshot: repo.pushSnapshot,
				},
				result: { id: repo.id, success: true, commits: [] },
				runId: "isolated",
				settings: CREATE_SETTINGS,
				skillLog: { logRepoOutcome() {} },
			});
			assert.equal(result.status, "SUCCESS", result.error);
			assert.equal(result.publishedSha, head);
			assert.equal(git(f.remote, ["rev-parse", "refs/heads/task"]), head);
			assert.equal(git(f.repo.dir, ["rev-parse", "HEAD"]), head);
			assert.equal(git(f.repo.dir, ["config", "--local", "--list"]), before);
			assert.equal(
				git(f.repo.dir, ["for-each-ref", "--format=%(refname) %(objectname)"]),
				refs,
			);
			// C33: known success cannot recreate a subsequently deleted destination.
			git(f.remote, ["update-ref", "-d", "refs/heads/task"]);
			const resumed = await handlePushOnlyCheckpointResult({
				repoId: repo.id,
				repoState: result,
				result: { id: repo.id, success: true, commits: [] },
				runId: "isolated",
				settings: CREATE_SETTINGS,
				skillLog: { logRepoOutcome() {} },
			});
			assert.equal(resumed.status, "SUCCESS");
			assert.equal(
				git(f.remote, [
					"for-each-ref",
					"--format=%(objectname)",
					"refs/heads/task",
				]),
				"",
			);
		} finally {
			f.repo.dispose();
		}
	});

test("C10 C22 C23 C30 | dirty detached creation directly at S, never B, with exact ref scope", async () => {
	const f = createFixture();
	try {
		git(f.repo.dir, ["config", "push.followTags", "true"]);
		git(f.repo.dir, ["config", "push.recurseSubmodules", "on-demand"]);
		git(f.repo.dir, ["tag", "-a", "unrelated", "-m", "unrelated"]);
		const updateLog = path.join(f.remote, "updates");
		const updateHook = path.join(f.remote, "hooks", "update");
		fs.writeFileSync(
			updateHook,
			`#!/bin/sh\nprintf '%s %s %s\\n' "$1" "$2" "$3" >> ${JSON.stringify(updateLog)}\n`,
		);
		fs.chmodSync(updateHook, 0o755);
		const prior = f.commit("prior.txt");
		fs.writeFileSync(path.join(f.repo.dir, "new.txt"), "new\n");
		const config = git(f.repo.dir, ["config", "--local", "--list"]);
		const [repo] = await runDiscovery(CREATE_SETTINGS, f.scope());
		assert.ok(repo?.explicitPushTargetSnapshot);
		const { diffHash } = await processRepoValidationAndDiff(
			repo,
			CREATE_SETTINGS,
		);
		const result = await executeMultiCommitAndPush(
			repo.path,
			[
				{
					commit: { type: "feat", description: "new work", isBreaking: false },
					files: ["new.txt"],
				},
			],
			diffHash,
			CREATE_SETTINGS,
			repo.explicitPushTargetSnapshot,
		);
		const head = git(f.repo.dir, ["rev-parse", "HEAD"]);
		assert.equal(result.publishedSha, head);
		assert.equal(result.committedShas.length, 1);
		assert.equal(
			fs.readFileSync(updateLog, "utf8").trim(),
			`refs/heads/task ${"0".repeat(head.length)} ${head}`,
			"the remote must receive exactly one creation, directly at final S",
		);
		assert.equal(git(f.repo.dir, ["rev-parse", `${head}^`]), prior);
		assert.equal(git(f.remote, ["rev-parse", "refs/heads/task"]), head);
		assert.equal(
			git(f.remote, ["for-each-ref", "--format=%(refname)"]),
			"refs/heads/source\nrefs/heads/task",
		);
		assert.equal(git(f.repo.dir, ["config", "--local", "--list"]), config);
		assert.throws(() => git(f.repo.dir, ["symbolic-ref", "HEAD"]));
	} finally {
		f.repo.dispose();
	}
});

test("C13 | a new invocation rejects an existing destination even at B or S", async () => {
	const f = createFixture();
	try {
		for (const head of [f.baseSha, f.commit()]) {
			git(f.repo.dir, ["push", "origin", `${head}:refs/heads/task`]);
			await assert.rejects(
				runDiscovery(CREATE_SETTINGS, f.scope()),
				/exist|present/u,
			);
		}
	} finally {
		f.repo.dispose();
	}
});

test("C21 | a secret in pre-existing B..HEAD history blocks dirty publication", async () => {
	const f = createFixture();
	try {
		f.commit("credentials.txt", `OPENAI_API_KEY=sk-${"A".repeat(48)}\n`);
		fs.writeFileSync(path.join(f.repo.dir, "new.txt"), "new\n");
		const [repo] = await runDiscovery(CREATE_SETTINGS, f.scope());
		assert.ok(repo);
		await assert.rejects(
			processRepoValidationAndDiff(repo, CREATE_SETTINGS),
			/Secret|Security/u,
		);
		assert.equal(
			git(f.remote, [
				"for-each-ref",
				"--format=%(objectname)",
				"refs/heads/task",
			]),
			"",
		);
	} finally {
		f.repo.dispose();
	}
});
