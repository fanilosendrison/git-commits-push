import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { PhaseIO } from "turnlock";
import { runDiscovery } from "../../src/modules/core/discovery.ts";
import { processRepoValidationAndDiff } from "../../src/modules/core/validators/pre-commit-validators.ts";
import { finalizeCreationOutcomePhase } from "../../src/modules/git/creation-outcome-checkpoint.ts";
import { runCommitAndPushPhase } from "../../src/phases/step2-commit-push.ts";
import type {
	CommitJobResult,
	GlobalState,
	RepoState,
} from "../../src/types.ts";
import {
	CREATE_SETTINGS,
	createFixture,
	git,
} from "../fixtures/targeted-create.ts";

for (const scenario of [
	"empty-after-partial",
	"empty-batch",
	"server-refusal",
	"interrupted-head",
	"invalid-anchor",
	"changed-index",
] as const)
	test(`C28 C31 C35 | ${scenario} cannot become successful publication or LLM replanning`, async () => {
		const f = createFixture();
		const previousSettings = process.env.TURNLOCK_SKILL_SETTINGS_PATH;
		try {
			const settingsPath = path.join(f.repo.dir, ".git", "settings.json");
			fs.writeFileSync(settingsPath, JSON.stringify(CREATE_SETTINGS));
			process.env.TURNLOCK_SKILL_SETTINGS_PATH = settingsPath;
			fs.writeFileSync(path.join(f.repo.dir, "work.txt"), "work\n");
			const scope = f.scope();
			const [repo] = await runDiscovery(CREATE_SETTINGS, scope);
			assert.ok(repo?.explicitPushTargetSnapshot);
			const validation = await processRepoValidationAndDiff(
				repo,
				CREATE_SETTINGS,
			);
			const repoState: RepoState = {
				repository: repo.path,
				operation: "commit-and-push",
				status: "RUNNING",
				explicitPushTargetSnapshot: repo.explicitPushTargetSnapshot,
				diffHash: validation.diffHash,
			};
			if (
				scenario === "empty-after-partial" ||
				scenario === "interrupted-head"
			) {
				const sha = f.commit();
				if (scenario === "empty-after-partial")
					repoState.committedShas = [{ sha, files: ["work.txt"] }];
			}
			if (scenario === "changed-index")
				f.repo.writeAndStage("work.txt", "newer staged content\n");
			const currentIndex = git(f.repo.dir, ["ls-files", "--stage"]);
			if (scenario === "invalid-anchor") {
				const target = repoState.explicitPushTargetSnapshot;
				assert.ok(target && "kind" in target);
				const tree = git(f.repo.dir, ["rev-parse", "HEAD^{tree}"]);
				const unrelated = git(f.repo.dir, [
					"commit-tree",
					tree,
					"-m",
					"unrelated anchor",
				]);
				repoState.explicitPushTargetSnapshot = {
					...target,
					observedBaseRefSha: unrelated,
				};
			}
			if (scenario === "server-refusal") {
				const hook = path.join(f.remote, "hooks", "pre-receive");
				fs.writeFileSync(
					hook,
					"#!/bin/sh\necho 'protected branch hook declined' >&2\nexit 1\n",
				);
				fs.chmodSync(hook, 0o755);
			}
			const results: CommitJobResult[] =
				scenario === "empty-batch"
					? []
					: [
							{
								id: repo.id,
								success: true,
								commits:
									scenario === "empty-after-partial"
										? []
										: [
												{
													commit: {
														type: "feat",
														description: "work",
														isBreaking: false,
													},
													files: ["work.txt"],
												},
											],
							},
						];
			let failed = false;
			let checkpointState: GlobalState | undefined;
			const io = {
				runId: "isolated",
				runDir: path.join(f.repo.dir, ".git"),
				consumePendingBatchResults: () =>
					checkpointState
						? [{ id: repo.id, success: true, commits: [] }]
						: results,
				fail: () => {
					failed = true;
					return {};
				},
				done: () => assert.fail("no publication proof"),
				delegateBatch: (
					request: { jobs: { prompt: string }[] },
					phase: string,
					nextState: GlobalState,
				) => {
					assert.equal(phase, "creation-outcome");
					assert.equal(
						JSON.parse(request.jobs[0]?.prompt ?? "{}").mode,
						"checkpoint-creation-outcome",
					);
					checkpointState = nextState;
					return {};
				},
			} as unknown as PhaseIO<GlobalState>;
			await runCommitAndPushPhase(
				{ invocationScope: scope, repos: { [repo.id]: repoState } },
				io,
			);
			assert.ok(checkpointState);
			assert.equal(checkpointState.repos[repo.id]?.status, "FAILED");
			await finalizeCreationOutcomePhase(checkpointState, io);
			assert.equal(failed, true);
			if (scenario === "server-refusal")
				assert.equal(
					checkpointState.repos[repo.id]?.committedShas?.at(-1)?.sha,
					git(f.repo.dir, ["rev-parse", "HEAD"]),
				);
			assert.equal(
				git(f.remote, [
					"for-each-ref",
					"--format=%(objectname)",
					"refs/heads/task",
				]),
				"",
			);
			if (scenario === "server-refusal")
				assert.notEqual(git(f.repo.dir, ["rev-parse", "HEAD"]), f.baseSha);
			if (scenario === "changed-index")
				assert.equal(
					git(f.repo.dir, ["ls-files", "--stage"]),
					currentIndex,
					"refusing a changed index must not reset or replan it",
				);
			if (scenario === "invalid-anchor")
				assert.equal(
					git(f.repo.dir, ["rev-parse", "HEAD"]),
					f.baseSha,
					"an incoherent persisted source anchor must be refused before any commit",
				);
		} finally {
			if (previousSettings === undefined)
				delete process.env.TURNLOCK_SKILL_SETTINGS_PATH;
			else process.env.TURNLOCK_SKILL_SETTINGS_PATH = previousSettings;
			f.repo.dispose();
		}
	});
