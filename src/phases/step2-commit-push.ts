import * as path from "node:path";
import type { PhaseIO, PhaseResult } from "turnlock";
import { readSettings } from "../config/settings.ts";
import { commitJobResultSchema } from "../config/state-schema.ts";
import { finalizeCommitPushPhase } from "../modules/core/commit-push-finalizer.ts";
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
import {
	MAX_ATTEMPTS_BY_KIND,
	queueRetry,
	retryJobs,
} from "../modules/core/queue-retry.ts";
import { loadSystemPrompt } from "../modules/core/system-prompt-loader.ts";
import { handleValidationRetry } from "../modules/core/validation-retry-handler.ts";
import { checkpointCreationOutcome } from "../modules/git/creation-outcome-checkpoint.ts";
import {
	creationResumeStopReason,
	creationRetryStopReason,
} from "../modules/git/creation-phase-safety.ts";
import { resolveFrozenExplicitTarget } from "../modules/git/explicit-push-target.ts";
import { executeMultiCommitAndPush } from "../modules/git/publisher.ts";
import { handlePushOnlyCheckpointResult } from "../modules/git/push-only-checkpoint.ts";
import { resetIndexForRetry } from "../modules/git/reset-index.ts";
import {
	assertExecutableInvocationScope,
	assertInvocationScopeCurrent,
} from "../modules/invocation/invocation-scope.ts";
import { createSkillStatsLog } from "../modules/telemetry/stats-logger.ts";
import type { GlobalState } from "../types.ts";

export { mergePostCommitPushFailure } from "../modules/core/committed-evidence.ts";

const skillLog = createSkillStatsLog();

export async function runCommitAndPushPhase(
	state: GlobalState,
	io: PhaseIO<GlobalState>,
): Promise<PhaseResult<GlobalState, unknown>> {
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

	let loopCount = 0;

	for (const result of results) {
		let repoState = nextRepos[result.id];
		if (!repoState) continue;
		if (
			state.invocationScope.kind === "targeted-create" &&
			repoState.status === "SUCCESS"
		)
			continue;

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
			loopCount += validationResult.loopCountDelta;
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
			} else if (
				err instanceof CommitPlanError &&
				err.context?.committedShas?.length
			) {
				repoState = {
					...repoState,
					committedShas: mergeCommittedShas(
						repoState.committedShas ?? [],
						err.context.committedShas,
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

			// R57 fix (C1): historical empty-plans with committedShas = SUCCESS
			if (classified.kind === "success") {
				nextRepos[result.id] = {
					...repoState,
					status: "SUCCESS" as const,
					commits: [],
					error:
						"LLM returned an empty plan after partial commits completed; treating as success.",
				};
				continue;
			}

			const errKind = classified.error.kind;
			const attempts = repoState.attempts?.[errKind] ?? 0;
			const maxAttempts = MAX_ATTEMPTS_BY_KIND[errKind];

			if (classified.kind === "retry" && attempts < maxAttempts) {
				if (state.invocationScope.kind !== "targeted-create")
					resetIndexForRetry(repoState.repository);

				repoState = {
					...repoState,
					attempts: {
						...(repoState.attempts ?? {}),
						[errKind]: attempts + 1,
					},
				};

				const retryResult = queueRetry(
					result.id,
					repoState,
					[classified.error],
					{ committedShas: repoState.committedShas, pendingFiles },
					settings,
					systemPrompt,
					result.commits,
				);

				if (retryResult.kind === "loop-detected") {
					loopCount++;
					skillLog.logLoopDetected({
						runId: currentRunId,
						repoId: result.id,
						kind: errKind,
						planHash: retryResult.repoState.lastPlanHash ?? "",
					});
					nextRepos[result.id] = {
						...retryResult.repoState,
						status: "FAILED" as const,
						error: `Loop detected: LLM returned an identical plan on two consecutive attempts for kind "${errKind}".`,
						loopDetected: {
							kind: errKind,
							planHash: retryResult.repoState.lastPlanHash ?? "",
						},
					};
					skillLog.logRepoOutcome({
						runId: currentRunId,
						repoId: result.id,
						repository: repoState.repository,
						status: "FAILED",
						error: `Loop detected for kind ${errKind}`,
						attempts: repoState.attempts ?? {},
						totalRetries: Object.values(repoState.attempts ?? {}).reduce(
							(a, b) => a + b,
							0,
						),
						loopDetected: {
							kind: errKind,
							planHash: retryResult.repoState.lastPlanHash ?? "",
						},
						committedCount: repoState.committedShas?.length ?? 0,
					});
					continue;
				}

				skillLog.logDelegation({
					runId: currentRunId,
					repoId: result.id,
					repository: repoState.repository,
					isRetry: true,
					retryKind: errKind,
					attempt: attempts + 1,
					model: settings.model,
					thinking: settings.thinking ?? false,
					diffHash: retryResult.repoState.diffHash ?? "",
					diffSizeBytes: null,
					previousDiffHash: repoState.diffHash ?? "",
					diffChanged:
						(repoState.diffHash ?? "") !==
						(retryResult.repoState.diffHash ?? ""),
					pendingFilesCount: pendingFiles?.length ?? null,
					feedbackHistoryItems: (repoState.feedbackHistory ?? []).length,
				});
				nextRepos[result.id] = retryResult.repoState;
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
	return finalizeCommitPushPhase(
		nextRepos,
		io,
		currentRunId,
		loopCount,
		skillLog,
	);
}
