import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { PhaseIO } from "turnlock";
import { stateSchema } from "../../src/config/state-schema.ts";
import { PostCommitPushError } from "../../src/modules/core/errors.ts";
import { handleLlmJobFailure } from "../../src/modules/core/llm-job-failure-handler.ts";
import { processRepoValidationAndDiff } from "../../src/modules/core/validators/pre-commit-validators.ts";
import { recoverCompletedCommit } from "../../src/modules/git/commit-completion.ts";
import { captureExplicitPushTargetSnapshot } from "../../src/modules/git/explicit-push-target.ts";
import { executeMultiCommitAndPush } from "../../src/modules/git/publisher.ts";
import {
	assertValidatedSource,
	readIndexSource,
} from "../../src/modules/git/validated-source.ts";
import { readValidatedRetryDiff } from "../../src/modules/git/validated-source-retry.ts";
import { readValidationInputDiff } from "../../src/modules/git/validation-source-input.ts";
import { createSkillStatsLog } from "../../src/modules/telemetry/stats-logger.ts";
import { runDiscoveryAndValidationPhase } from "../../src/phases/step1-discovery-validation.ts";
import type { GlobalState, RepoState } from "../../src/types.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import {
	CREATE_SETTINGS,
	createFixture,
	git,
} from "../fixtures/targeted-create.ts";

test("required publication disappearing after validation cannot resolve as publisher success", async () => {
	const f = createFixture();
	try {
		git(f.repo.dir, [
			"checkout",
			"--quiet",
			git(f.repo.dir, [
				"for-each-ref",
				"--format=%(refname:short)",
				"refs/heads",
			]),
		]);
		f.repo.writeAndStage("source.ts", "validated fixture\n");
		const settings = { ...CREATE_SETTINGS, autoPush: true };
		const v = await processRepoValidationAndDiff(
			{ id: "task", path: f.repo.dir },
			settings,
		);
		assert.equal(v.validatedSource.publicationRequired, true);
		git(f.repo.dir, ["remote", "remove", "origin"]);
		await assert.rejects(
			executeMultiCommitAndPush(
				f.repo.dir,
				[
					{
						commit: {
							type: "test",
							description: "retain required publication",
							isBreaking: false,
						},
						files: ["source.ts"],
					},
				],
				v.diffHash,
				settings,
				undefined,
				{ witness: v.validatedSource },
			),
			(error) =>
				error instanceof PostCommitPushError &&
				error.context.committedShas.length === 1 &&
				/Required exact publication/.test(error.message),
		);
		assert.notEqual(git(f.repo.dir, ["rev-parse", "HEAD"]), f.baseSha);
		assert.equal(git(f.remote, ["rev-parse", "refs/heads/source"]), f.baseSha);
		assert.equal(git(f.repo.dir, ["remote"]), "");
	} finally {
		f.repo.dispose();
	}
});

test("validation diff is read from immutable H0/T even if the live index changes", () => {
	const repo = GitRepoFixture.create();
	try {
		repo.commit("base");
		repo.writeAndStage("source.ts", "validated fixture\n");
		const input = readIndexSource(repo.dir);
		repo.writeAndStage("source.ts", "raced fixture\n");
		const diff = readValidationInputDiff(repo.dir, input, false);
		assert.match(diff, /validated fixture/);
		assert.doesNotMatch(diff, /raced fixture/);
		assert.equal(
			git(repo.dir, ["show", `${input.expectedTreeSha}:source.ts`]),
			"validated fixture",
		);
	} finally {
		repo.dispose();
	}
});

for (const mutation of ["index", "worktree", "untracked", "head"] as const)
	test(`validation cannot ratify ${mutation} changes that occurred during scanning`, async () => {
		const repo = GitRepoFixture.create();
		try {
			repo.commit("base");
			repo.writeAndStage("source.ts", "validated fixture\n");
			let racedHead = "";
			let racedTree = "";
			await assert.rejects(
				processRepoValidationAndDiff(
					{ id: "task", path: repo.dir },
					CREATE_SETTINGS,
					async (diff) => {
						assert.match(diff, /validated fixture/);
						if (mutation === "index")
							repo.writeAndStage("source.ts", "raced fixture\n");
						if (mutation === "worktree")
							writeFileSync(
								path.join(repo.dir, "source.ts"),
								"raced fixture\n",
							);
						if (mutation === "untracked")
							writeFileSync(path.join(repo.dir, "late.ts"), "late fixture\n");
						if (mutation === "head")
							git(repo.dir, [
								"commit",
								"--no-verify",
								"-m",
								"test: concurrent fixture effect",
							]);
						racedHead = git(repo.dir, ["rev-parse", "HEAD"]);
						racedTree = git(repo.dir, ["write-tree"]);
						return { hasSecrets: false, matchCount: 0 };
					},
				),
				/changed|source authority/,
			);
			assert.equal(git(repo.dir, ["rev-parse", "HEAD"]), racedHead);
			assert.equal(git(repo.dir, ["write-tree"]), racedTree);
		} finally {
			repo.dispose();
		}
	});

for (const mode of ["local", "published", "unpublished"] as const)
	test(`complete-chain recovery ${mode} uses Git and publication evidence, never empty inference`, async () => {
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
			f.repo.writeAndStage("a.ts", "a\n");
			f.repo.writeAndStage("b.ts", "b\n");
			const target =
				mode === "local"
					? undefined
					: captureExplicitPushTargetSnapshot(f.repo.dir, {
							remote: "origin",
							destinationRef: "refs/heads/source",
						});
			const v = await processRepoValidationAndDiff(
				{
					id: "task",
					path: f.repo.dir,
					...(target ? { explicitPushTargetSnapshot: target } : {}),
				},
				CREATE_SETTINGS,
			);
			const before = JSON.stringify(v.validatedSource);
			git(f.repo.dir, [
				"commit",
				"--no-verify",
				"-m",
				"test: preserve complete validated content",
			]);
			const sha = git(f.repo.dir, ["rev-parse", "HEAD"]);
			if (mode === "published")
				git(f.repo.dir, ["push", "origin", `${sha}:refs/heads/source`]);
			const repo: RepoState = {
				repository: f.repo.dir,
				operation: "commit-and-push",
				status: "RUNNING",
				validatedSource: v.validatedSource,
				...(target ? { explicitPushTargetSnapshot: target } : {}),
				committedShas: [{ sha, files: ["a.ts", "b.ts"] }],
				...(mode === "published"
					? { publishedSha: git(f.remote, ["rev-parse", "refs/heads/source"]) }
					: {}),
			};
			assert.throws(
				() => readValidatedRetryDiff(repo),
				/No remaining validated diff/,
			);
			if (mode === "unpublished") {
				assert.throws(
					() => recoverCompletedCommit(repo),
					/lack durable required publication/,
				);
				const contradictory = {
					...repo,
					validatedSource: { ...v.validatedSource, publicationRequired: false },
				};
				assert.throws(
					() => recoverCompletedCommit(contradictory),
					/publication/,
				);
				assert.equal(
					stateSchema.safeParse({
						invocationScope: {
							kind: "targeted",
							repository: f.repo.dir,
							pushRemote: "origin",
							pushRef: "refs/heads/source",
						},
						repos: { task: contradictory },
					}).success,
					false,
				);
			} else {
				const recovered = recoverCompletedCommit(repo);
				assert.equal(recovered?.status, "SUCCESS");
				assert.deepEqual(recovered?.commitCompletion, {
					finalHeadSha: sha,
					finalTreeSha: v.validatedSource.expectedTreeSha,
				});
				assert.equal(
					recovered?.publishedSha,
					mode === "published" ? sha : undefined,
				);
			}
			assert.equal(JSON.stringify(v.validatedSource), before);
			assert.equal(git(f.repo.dir, ["rev-parse", "HEAD"]), sha);
		} finally {
			f.repo.dispose();
		}
	});

for (const error of [
	"empty response",
	"expected non-empty JSON array",
	"response interrupted",
])
	test(`NEGATIVE_03: ${error} cannot promote landed commits to success`, () => {
		const committedShas = [{ sha: "a".repeat(40), files: ["landed.ts"] }];
		const result = handleLlmJobFailure({
			result: { id: "task", success: false, error },
			repoState: {
				repository: "/diagnostic",
				status: "RUNNING",
				committedShas,
				publishedSha: "a".repeat(40),
			},
			runId: "fixture",
			settings: CREATE_SETTINGS,
			skillLog: createSkillStatsLog(),
			systemPrompt: "",
		});
		assert.equal(result.status, "FAILED");
		assert.deepEqual(result.committedShas, committedShas);
		assert.equal(result.publishedSha, "a".repeat(40));
	});

test("resumed pristine discovery refuses before reading or staging any repository", async () => {
	await assert.rejects(
		runDiscoveryAndValidationPhase(
			{
				invocationScope: {
					kind: "worktree",
					repository: "/unreadable-fixture",
				},
				repos: {},
			},
			{} as PhaseIO<GlobalState>,
			true,
		),
		/Discovery resume cannot establish/,
	);
});

test("NEGATIVE_09: legacy state remains readable without granting witness authority", () => {
	const state = stateSchema.parse({
		repos: {
			old: {
				repository: "/diagnostic",
				status: "RUNNING",
				committedShas: [{ sha: "historical", files: ["a"] }],
			},
		},
	});
	assert.equal(state.repos.old?.validatedSource, undefined);
	assert.throws(
		() => assertValidatedSource("/diagnostic", undefined),
		/Missing durable/,
	);
});
