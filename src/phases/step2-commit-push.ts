import * as path from "node:path";
import type { PhaseIO, PhaseResult } from "turnlock";
import { readSettings } from "../config/settings.ts";
import { commitJobResultSchema } from "../config/state-schema.ts";
import {
	mergeCommittedShas,
	mergePostCommitPushFailure,
	preserveOriginalHead,
} from "../modules/core/committed-evidence.ts";
import { classifyError } from "../modules/core/error-classifier.ts";
import {
	CommitPlanError,
	PartialCommitError,
	PostCommitPushError,
} from "../modules/core/errors.ts";
import { handleLlmJobFailure } from "../modules/core/llm-job-failure-handler.ts";
import { retryPublicationPlan } from "../modules/core/publication-plan-retry.ts";
import {
	MAX_ATTEMPTS_BY_KIND,
	retryJobs,
} from "../modules/core/queue-retry.ts";
import { loadSystemPrompt } from "../modules/core/system-prompt-loader.ts";
import { handleValidationRetry } from "../modules/core/validation-retry-handler.ts";
import { recoverCompletedCommit } from "../modules/git/commit-completion.ts";
import { checkpointCommitOutcome } from "../modules/git/commit-outcome-checkpoint.ts";
import { checkpointCreationOutcome } from "../modules/git/creation-outcome-checkpoint.ts";
import {
	creationResumeStopReason,
	creationRetryStopReason,
} from "../modules/git/creation-phase-safety.ts";
import { resolveFrozenExplicitTarget } from "../modules/git/explicit-push-target.ts";
import { executeMultiCommitAndPush } from "../modules/git/publisher.ts";
import { handlePushOnlyCheckpointResult } from "../modules/git/push-only-checkpoint.ts";
import { assertValidatedSource } from "../modules/git/validated-source.ts";
import {
	assertExecutableInvocationScope,
	assertInvocationScopeCurrent,
} from "../modules/invocation/invocation-scope.ts";
import { acceptPlanningBudget } from "../modules/llm/planning-attempt-budget.ts";
import { createSkillStatsLog } from "../modules/telemetry/stats-logger.ts";
import type { GlobalState } from "../types.ts";

export { mergePostCommitPushFailure } from "../modules/core/committed-evidence.ts";

const skillLog = createSkillStatsLog();

export async function runCommitAndPushPhase(
	state: GlobalState,
	io: PhaseIO<GlobalState>,
): Promise<PhaseResult<GlobalState, unknown>> {
	if (state.invocationScope.kind === "prepared-merge")
		return io.fail(
			new Error(
				"Prepared merge cannot enter historical planning or commit execution.",
			),
		);
	assertExecutableInvocationScope(state.invocationScope);
	assertInvocationScopeCurrent(state.invocationScope);

	if (
		state.invocationScope.kind === "targeted-create" &&
		Object.keys(state.repos).length === 0
	)
		return io.fail(new Error("Creation resume has no publication evidence."));
	const settings = readSettings(path.resolve(import.meta.dirname, "../config"));

	// ── Init stats vars for resume flow ────────────────────────────
	const currentRunId = io.runId;

	// Try to read system prompt if present, else empty string
	let systemPrompt = "";
	try {
		systemPrompt = loadSystemPrompt(
			import.meta.dirname,
			settings.systemPromptPath,
		);
	} catch {
		// ignore
	}

	// Phase 4: Retrieve results
	const results = io.consumePendingBatchResults(commitJobResultSchema);
	const nextRepos = { ...state.repos };

	// Drain any leftover jobs from a previous failed iteration of this phase.
	// R26 invariant: only safe if Turnlock guarantees single-instance execution.
	retryJobs.length = 0;

	for (const result of results) {
		let repoState = nextRepos[result.id];
		if (!repoState) continue;
		// A terminal checkpoint grants reporting authority only, never another publication.
		if (repoState.status === "SUCCESS") continue;

		if (state.invocationScope.kind === "targeted-create") {
			const reason = creationResumeStopReason(repoState);
			if (reason) {
				nextRepos[result.id] = {
					...repoState,
					status: "FAILED",
					error: reason,
				};
				continue;
			}
		}
		if (repoState.operation === "push-only") {
			nextRepos[result.id] = await handlePushOnlyCheckpointResult({
				repoId: result.id,
				repoState,
				result,
				runId: currentRunId,
				settings,
				skillLog,
			});
			continue;
		}

		try {
			const completed = recoverCompletedCommit(repoState);
			if (completed) {
				nextRepos[result.id] = completed;
				continue;
			}
		} catch (error) {
			nextRepos[result.id] = {
				...repoState,
				status: "FAILED",
				error: error instanceof Error ? error.message : String(error),
			};
			continue;
		}

		try {
			repoState = {
				...repoState,
				planningBudget: acceptPlanningBudget(
					repoState.planningBudget,
					result.planningBudget,
				),
			};
		} catch (error) {
			nextRepos[result.id] = {
				...repoState,
				status: "FAILED",
				error:
					error instanceof Error ? error.message : "Invalid planning budget",
			};
			continue;
		}

		if (!result.success) {
			nextRepos[result.id] = handleLlmJobFailure({
				result,
				repoState,
				runId: currentRunId,
				settings,
				skillLog,
				systemPrompt,
			});
			continue;
		}

		// 1. Validate commit messages and apply the bounded repair policy.
		const validationResult = handleValidationRetry({
			repoId: result.id,
			repoState,
			plans: result.commits,
			settings,
			systemPrompt,
			runId: currentRunId,
			skillLog,
		});
		if (validationResult.handled) {
			nextRepos[result.id] = validationResult.repoState;
			continue;
		}

		// 2. Execution + error classification
		if (!repoState.diffHash) {
			throw new Error(`Cannot push: diffHash missing for ${result.id}`);
		}

		try {
			const frozenExplicitTarget = resolveFrozenExplicitTarget(
				state.invocationScope,
				repoState.repository,
				repoState.explicitPushTargetSnapshot,
			);
			const {
				creationPublicationSnapshot,
				commitCompletion,
				committedShas,
				originalHead,
				pushRetryCount,
				publishedSha,
				remoteTrackingRefSynchronization,
			} = await executeMultiCommitAndPush(
				repoState.repository,
				result.commits,
				repoState.diffHash,
				settings,
				frozenExplicitTarget,
				{
					witness: assertValidatedSource(
						repoState.repository,
						repoState.validatedSource,
						repoState.committedShas,
						repoState.publisherIndexTreeSha,
					).witness,
					committedShas: repoState.committedShas,
					publisherIndexTreeSha: repoState.publisherIndexTreeSha,
				},
			);
			// Merge with anything that landed in prior retries.
			repoState = {
				...repoState,
				committedShas: mergeCommittedShas(
					repoState.committedShas ?? [],
					committedShas,
				),
				originalHead: preserveOriginalHead(
					repoState.originalHead,
					originalHead,
				),
				...(creationPublicationSnapshot ? { creationPublicationSnapshot } : {}),
				publishedSha: publishedSha ?? repoState.publishedSha,
				remoteTrackingRefSynchronization:
					remoteTrackingRefSynchronization ??
					repoState.remoteTrackingRefSynchronization,
				attempts:
					pushRetryCount > 0
						? {
								...(repoState.attempts ?? {}),
								network: (repoState.attempts?.network ?? 0) + pushRetryCount,
							}
						: repoState.attempts,
			};
			nextRepos[result.id] = {
				...repoState,
				status: "SUCCESS" as const,
				publisherIndexTreeSha: undefined,
				commitCompletion,
				commits: result.commits,
			};
		} catch (err) {
			// Preserve every durable commit before classifying the retry strategy.
			let pendingFiles: string[] | undefined;
			if (err instanceof PostCommitPushError) {
				repoState = mergePostCommitPushFailure(repoState, err);
			} else if (err instanceof PartialCommitError) {
				repoState = {
					...repoState,
					publisherIndexTreeSha: err.context.publisherIndexTreeSha,
					committedShas: mergeCommittedShas(
						repoState.committedShas ?? [],
						err.context.committedShas,
					),
					originalHead: preserveOriginalHead(
						repoState.originalHead,
						err.context.originalHead,
					),
				};
				pendingFiles = err.context.pendingFiles;
			} else if (err instanceof CommitPlanError && err.context) {
				repoState = {
					...repoState,
					publisherIndexTreeSha: err.context.publisherIndexTreeSha,
					committedShas: mergeCommittedShas(
						repoState.committedShas ?? [],
						err.context.committedShas ?? [],
					),
				};
				pendingFiles = err.context.pendingFiles;
			}

			const committedShasExist = (repoState.committedShas?.length ?? 0) > 0;
			const classified = classifyError(err, committedShasExist);

			const creationStop = creationRetryStopReason(
				state.invocationScope,
				committedShasExist,
				classified,
			);
			if (creationStop) {
				nextRepos[result.id] = {
					...repoState,
					status: "FAILED",
					error: creationStop,
				};
				continue;
			}

			const errKind = classified.error.kind;
			const attempts = repoState.attempts?.[errKind] ?? 0;
			const maxAttempts = MAX_ATTEMPTS_BY_KIND[errKind];

			if (classified.kind === "retry" && attempts < maxAttempts) {
				nextRepos[result.id] = retryPublicationPlan({
					repoId: result.id,
					repo: repoState,
					error: classified.error,
					pendingFiles,
					settings,
					systemPrompt,
					plans: result.commits,
					runId: currentRunId,
					skillLog,
				});
				continue;
			}

			nextRepos[result.id] = {
				...repoState,
				status: "FAILED" as const,
				error: classified.error.message,
			};
			skillLog.logRepoOutcome({
				runId: currentRunId,
				repoId: result.id,
				repository: repoState.repository,
				status: "FAILED",
				error: classified.error.message,
				attempts: repoState.attempts ?? {},
				totalRetries: Object.values(repoState.attempts ?? {}).reduce(
					(a, b) => a + b,
					0,
				),
				committedCount: repoState.committedShas?.length ?? 0,
			});
		}
	}

	if (retryJobs.length > 0) {
		const jobsSnapshot = retryJobs.slice();
		return io.delegateBatch(
			{
				kind: "batch",
				target: { kind: "worker", name: "git-commit-generator" },
				label: `commit-jobs-retry-${Date.now()}`, // unique per retry
				jobs: jobsSnapshot,
				timeout: { perDelegationMs: 600_000 },
				retry: {
					maxAttempts: 1,
					backoffBaseMs: 1000,
					maxBackoffMs: 30000,
				},
			},
			"commit-and-push",
			{
				...state,
				repos: nextRepos,
			},
		);
	}

	if (state.invocationScope.kind === "targeted-create")
		return checkpointCreationOutcome(state, nextRepos, io);
	return checkpointCommitOutcome(state, nextRepos, io);
}
