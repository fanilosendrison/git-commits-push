import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { queueRetry, retryJobs } from "../../src/modules/core/queue-retry.ts";
import { processRepoValidationAndDiff } from "../../src/modules/core/validators/pre-commit-validators.ts";
import { captureExplicitPushTargetSnapshot } from "../../src/modules/git/explicit-push-target.ts";
import { executeMultiCommitAndPush } from "../../src/modules/git/publisher.ts";
import type { CommitPlan, RepoState } from "../../src/types.ts";
import {
	CREATE_SETTINGS,
	createFixture,
	git,
} from "../fixtures/targeted-create.ts";

afterEach(() => {
	retryJobs.length = 0;
});

for (const mode of ["local", "explicit"] as const)
	for (const noPrefix of [false, true])
		test(`unchanged ${mode} source with mnemonic prefixes and noprefix=${noPrefix} retains its validated hash`, async () => {
			const f = createFixture();
			try {
				if (mode === "local")
					git(f.repo.dir, [
						"checkout",
						"--quiet",
						git(f.repo.dir, [
							"for-each-ref",
							"--format=%(refname:short)",
							"refs/heads",
						]),
					]);
				git(f.repo.dir, ["config", "diff.mnemonicPrefix", "true"]);
				git(f.repo.dir, ["config", "diff.noprefix", String(noPrefix)]);
				f.repo.writeAndStage("a.ts", "first fixture\n");
				f.repo.writeAndStage("b.ts", "second fixture\n");
				const target =
					mode === "explicit"
						? captureExplicitPushTargetSnapshot(f.repo.dir, {
								remote: "origin",
								destinationRef: "refs/heads/source",
							})
						: undefined;
				const v = await processRepoValidationAndDiff(
					{
						id: "task",
						path: f.repo.dir,
						...(target ? { explicitPushTargetSnapshot: target } : {}),
					},
					CREATE_SETTINGS,
				);
				const T = git(f.repo.dir, ["write-tree"]);
				const plan: CommitPlan = {
					commit: {
						type: "test",
						description: "preserve validated input binding",
						isBreaking: false,
					},
					files: ["a.ts", "b.ts"],
				};
				const plans = [plan];
				const repo: RepoState = {
					repository: f.repo.dir,
					operation: "commit-and-push",
					status: "RUNNING",
					diffHash: v.diffHash,
					validatedSource: v.validatedSource,
					...(target ? { explicitPushTargetSnapshot: target } : {}),
				};
				const retry = queueRetry(
					"task",
					repo,
					[{ kind: "structural", message: "fixture pre-effect retry" }],
					{},
					CREATE_SETTINGS,
					"",
					[{ ...plan, files: ["a.ts"] }],
				);
				assert.equal(retry.kind, "queued");
				if (retry.kind !== "queued")
					assert.fail("fixture retry was not queued");
				const payload = JSON.parse(retry.job.prompt) as {
					diff: string;
					diffHash: string;
				};
				assert.equal(git(f.repo.dir, ["rev-parse", "HEAD"]), f.baseSha);
				assert.equal(git(f.repo.dir, ["write-tree"]), T);
				const result = await executeMultiCommitAndPush(
					f.repo.dir,
					plans,
					v.diffHash,
					CREATE_SETTINGS,
					target,
					{ witness: v.validatedSource },
				);
				assert.equal(payload.diff, v.diff);
				assert.equal(payload.diffHash, v.diffHash);
				const head = git(f.repo.dir, ["rev-parse", "HEAD"]);
				assert.equal(git(f.repo.dir, ["rev-parse", "HEAD^{tree}"]), T);
				assert.equal(result.committedShas.length, 1);
				assert.equal(result.publishedSha, mode === "explicit" ? head : null);
				assert.equal(
					git(f.remote, ["rev-parse", "refs/heads/source"]),
					mode === "explicit" ? head : f.baseSha,
				);
			} finally {
				f.repo.dispose();
			}
		});
