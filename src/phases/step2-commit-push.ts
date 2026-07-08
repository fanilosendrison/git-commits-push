import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PhaseIO, PhaseResult } from "turnlock";
import { readSettings } from "../config/settings.ts";
import { commitJobResultSchema } from "../config/state-schema.ts";
import {
	classifyError,
	classifyLLMFailure,
} from "../modules/core/error-classifier.ts";
import { CommitPlanError, PartialCommitError } from "../modules/core/errors.ts";
import {
	buildFallbackSettings,
	shouldUseFallback,
} from "../modules/core/fallback-model.ts";
import {
	MAX_ATTEMPTS_BY_KIND,
	queueRetry,
	retryJobs,
} from "../modules/core/queue-retry.ts";
import { printReport } from "../modules/core/reporter.ts";
import { validateCommitMessage } from "../modules/core/validators/commit-message-validator.ts";
import { formatConventionalCommit } from "../modules/formatters/commit-formatter.ts";
import { executeMultiCommitAndPush } from "../modules/git/publisher.ts";
import { createSkillStatsLog } from "../modules/telemetry/stats-logger.ts";
import type { FeedbackError, GlobalState } from "../types.ts";
import { releaseLockAndTriggerNext } from "../utils/lock-manager.ts";

const skillLog = createSkillStatsLog();
const runStartEpochMs = 0;

export async function runCommitAndPushPhase(
	state: GlobalState,
	io: PhaseIO<GlobalState>,
): Promise<PhaseResult<GlobalState, unknown>> {
	const settings = readSettings(path.resolve(import.meta.dir, "../config"));

	// ── Init stats vars for resume flow ────────────────────────────
	const currentRunId = io.runId;

	// Try to read system prompt if present, else empty string
	let systemPrompt = "";
	try {
		const promptPath = path.resolve(
			import.meta.dir,
			settings.systemPromptPath || "../../system-prompt.md",
		);
		if (fs.existsSync(promptPath)) {
			systemPrompt = fs.readFileSync(promptPath, "utf-8");
		}
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

		if (!result.success) {
			// R7 + R27 fix: classify LLM-side failures instead of hardcoding "git"
			const llmKind = classifyLLMFailure(result.error);
			if (llmKind === null) {
				// R57 mirror (C1): if LLM returned empty plans but commits already landed,
				// treat as SUCCESS — same logic as classifyError for CommitPlanError(empty-plans).
				const isLlmEmptyPlans =
					result.error.includes("empty") ||
					result.error.includes("non-empty JSON array");
				const committedShasExist = (repoState.committedShas?.length ?? 0) > 0;
				if (isLlmEmptyPlans && committedShasExist) {
					nextRepos[result.id] = {
						...repoState,
						status: "SUCCESS" as const,
						commits: [],
						error:
							"LLM returned an empty plan after partial commits completed; treating as success.",
					};
					continue;
				}
				// Fail-closed for unknown/bridge errors
				nextRepos[result.id] = {
					...repoState,
					status: "FAILED" as const,
					error: `LLM fatal error: ${result.error}`,
				};
				skillLog.logRepoOutcome({
					runId: currentRunId,
					repoId: result.id,
					repository: repoState.repository,
					status: "FAILED",
					error: result.error,
					attempts: repoState.attempts ?? {},
					totalRetries: Object.values(repoState.attempts ?? {}).reduce(
						(a, b) => a + b,
						0,
					),
					committedCount: 0,
				});
				continue;
			}
			// R38 fix: direct access replaces bumpAttempt
			const attempts = repoState.attempts?.[llmKind] ?? 0;
			if (attempts < MAX_ATTEMPTS_BY_KIND[llmKind]) {
				repoState = {
					...repoState,
					attempts: {
						...(repoState.attempts ?? {}),
						[llmKind]: attempts + 1,
					},
				};
				const retryResult = queueRetry(
					result.id,
					repoState,
					[
						{
							kind: llmKind,
							message: result.error,
							resolution_hint:
								"The previous LLM response was malformed. Regenerate based on the current diff.",
						},
					],
					{},
					settings,
					systemPrompt,
					[], // no plans to hash — LLM never returned parseable output
				);
				if (retryResult.kind === "loop-detected") {
					skillLog.logLoopDetected({
						runId: currentRunId,
						repoId: result.id,
						kind: llmKind,
						planHash: retryResult.repoState.lastPlanHash ?? "",
					});
					nextRepos[result.id] = {
						...retryResult.repoState,
						status: "FAILED" as const,
						error: "Loop detected after LLM-side failure.",
					};
					continue;
				}
				skillLog.logDelegation({
					runId: currentRunId,
					repoId: result.id,
					repository: repoState.repository,
					isRetry: true,
					retryKind: llmKind,
					attempt: attempts + 1,
					model: settings.model,
					thinking: settings.thinking ?? false,
					diffHash: retryResult.repoState.diffHash ?? "",
					retryReason: result.error?.slice(0, 200),
					diffSizeBytes: null,
					previousDiffHash: repoState.diffHash ?? "",
					diffChanged:
						(repoState.diffHash ?? "") !==
						(retryResult.repoState.diffHash ?? ""),
					pendingFilesCount: null,
					feedbackHistoryItems: (repoState.feedbackHistory ?? []).length,
				});
				nextRepos[result.id] = retryResult.repoState;
				continue;
			}
			nextRepos[result.id] = {
				...repoState,
				status: "FAILED" as const,
				error: `LLM fatal error after max retries: ${result.error}`,
			};
			skillLog.logRepoOutcome({
				runId: currentRunId,
				repoId: result.id,
				repository: repoState.repository,
				status: "FAILED",
				error: result.error,
				attempts: repoState.attempts ?? {},
				totalRetries: Object.values(repoState.attempts ?? {}).reduce(
					(a, b) => a + b,
					0,
				),
				committedCount: repoState.committedShas?.length ?? 0,
			});
			continue;
		}

		// 1. Validation phase — uses its own per-kind counter (validation)
		const validationErrors: FeedbackError[] = [];
		for (const plan of result.commits) {
			const msgStr = formatConventionalCommit(plan.commit);
			const subject = msgStr.split("\n")[0] ?? "";
			const valRes = validateCommitMessage(msgStr);
			if (!valRes.valid) {
				for (const e of valRes.errors) {
					validationErrors.push({
						kind: "validation",
						message: `${e} on "${subject}"`,
						resolution_hint:
							"Rewrite the commit message to comply with Conventional Commits.",
					});
				}
			}
		}
		const validationAttempts = repoState.attempts?.validation ?? 0;
		if (
			validationErrors.length > 0 &&
			validationAttempts < MAX_ATTEMPTS_BY_KIND.validation
		) {
			repoState = {
				...repoState,
				attempts: {
					...(repoState.attempts ?? {}),
					validation: validationAttempts + 1,
				},
			};
			const validationRetrySettings = repoState.fallbackAttempted
				? buildFallbackSettings(settings)
				: settings;
			// R11 fix: pass the plan structure, not formatted messages
			const retryResult = queueRetry(
				result.id,
				repoState,
				validationErrors,
				{},
				validationRetrySettings,
				systemPrompt,
				result.commits,
			);
			skillLog.logDelegation({
				runId: currentRunId,
				repoId: result.id,
				repository: repoState.repository,
				isRetry: true,
				retryKind: "validation",
				attempt: validationAttempts + 1,
				model: validationRetrySettings.model,
				retryReason: validationErrors
					.map((e) => e.message)
					.join("; ")
					.slice(0, 200),
				thinking: settings.thinking ?? false,
				diffHash: retryResult.repoState.diffHash ?? "",
				diffSizeBytes: null,
				previousDiffHash: repoState.diffHash ?? "",
				diffChanged:
					(repoState.diffHash ?? "") !== (retryResult.repoState.diffHash ?? ""),
				pendingFilesCount: null,
				feedbackHistoryItems: (repoState.feedbackHistory ?? []).length,
			});
			if (retryResult.kind === "loop-detected") {
				nextRepos[result.id] = {
					...retryResult.repoState,
					status: "FAILED" as const,
					error: `Loop detected: LLM returned an identical plan on two consecutive attempts for kind "validation".`,
				};
				continue;
			}
			nextRepos[result.id] = retryResult.repoState;
			continue;
		}
		if (validationErrors.length > 0) {
			// Try fallback model before failing
			if (
				shouldUseFallback(
					settings,
					"validation",
					validationAttempts,
					repoState.fallbackAttempted ?? false,
				)
			) {
				const fallbackSettings = buildFallbackSettings(settings);
				const retryResult = queueRetry(
					result.id,
					{
						...repoState,
						fallbackAttempted: true,
						attempts: {
							...(repoState.attempts ?? {}),
							validation: 0, // reset budget for fallback
						},
					},
					validationErrors,
					{},
					fallbackSettings, // override provider/model
					systemPrompt,
					result.commits,
				);
				skillLog.logDelegation({
					runId: currentRunId,
					repoId: result.id,
					repository: repoState.repository,
					isRetry: true,
					retryKind: "validation",
					attempt: 1,
					model: fallbackSettings.model,
					thinking: settings.thinking ?? false,
					diffHash: retryResult.repoState.diffHash ?? "",
					diffSizeBytes: null,
					previousDiffHash: repoState.diffHash ?? "",
					diffChanged:
						(repoState.diffHash ?? "") !==
						(retryResult.repoState.diffHash ?? ""),
					pendingFilesCount: null,
					feedbackHistoryItems: (repoState.feedbackHistory ?? []).length,
				});
				if (retryResult.kind === "loop-detected") {
					nextRepos[result.id] = {
						...retryResult.repoState,
						status: "FAILED" as const,
						error: `Loop detected after fallback: LLM returned an identical plan.`,
					};
					continue;
				}
				nextRepos[result.id] = retryResult.repoState;
				continue;
			}

			nextRepos[result.id] = {
				...repoState,
				status: "FAILED" as const,
				error: `Validation failed after max retries: ${validationErrors.map((e) => e.message).join(", ")}`,
			};
			continue;
		}

		// 2. Execution + error classification
		if (!repoState.diffHash) {
			throw new Error(`Cannot push: diffHash missing for ${result.id}`);
		}

		try {
			const { committedShas, originalHead } = await executeMultiCommitAndPush(
				repoState.repository,
				result.commits,
				repoState.diffHash,
				settings,
			);
			// Merge with anything that landed in prior retries
			repoState = {
				...repoState,
				committedShas: [...(repoState.committedShas ?? []), ...committedShas],
				originalHead,
			};
			nextRepos[result.id] = {
				...repoState,
				status: "SUCCESS" as const,
				commits: result.commits,
			};
		} catch (err) {
			// R59 fix (C3): merge err.context.committedShas before checking
			let pendingFiles: string[] | undefined;
			if (err instanceof PartialCommitError) {
				repoState = {
					...repoState,
					committedShas: [
						...(repoState.committedShas ?? []),
						...err.context.committedShas,
					],
					originalHead: err.context.originalHead,
				};
				pendingFiles = err.context.pendingFiles;
			} else if (
				err instanceof CommitPlanError &&
				err.context?.committedShas?.length
			) {
				repoState = {
					...repoState,
					committedShas: [
						...(repoState.committedShas ?? []),
						...err.context.committedShas,
					],
				};
				pendingFiles = err.context.pendingFiles;
			}

			const committedShasExist = (repoState.committedShas?.length ?? 0) > 0;
			const classified = classifyError(err, committedShasExist);

			// R57 fix (C1): empty-plans with committedShas = SUCCESS
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
				// R74 fix: re-attempt git reset HEAD before queuing retry
				try {
					execSync("git reset HEAD", {
						cwd: repoState.repository,
						encoding: "utf-8",
						stdio: ["pipe", "pipe", "pipe"],
					});
				} catch (resetErr) {
					process.stderr.write(
						`[git-commits-push-tl] orchestrator reset HEAD failed during retry prep: ` +
							`${resetErr instanceof Error ? resetErr.message : String(resetErr)}\n`,
					);
				}

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
		return io.delegateAgentBatch(
			{
				kind: "agent-batch",
				agentType: "git-commit-generator",
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
			{ repos: nextRepos },
		);
	}

	// Phase 5: Reporting
	printReport(nextRepos);

	const successCount = Object.values(nextRepos).filter(
		(r) => r.status === "SUCCESS",
	).length;
	const failCount = Object.values(nextRepos).filter(
		(r) => r.status === "FAILED",
	).length;
	const totalRepos = Object.keys(nextRepos).length;
	const totalRetries = Object.values(nextRepos).reduce((sum, repoState) => {
		return (
			sum +
			Object.values(repoState.attempts ?? {}).reduce(
				(repoSum, count) => repoSum + count,
				0,
			)
		);
	}, 0);

	// Resolve run start epoch: first invocation sets runStartEpochMs in discovery;
	// resume must read it from state.json (new process has runStartEpochMs === 0).
	let startEpoch = runStartEpochMs;
	if (startEpoch === 0) {
		try {
			const statePath = path.join(io.runDir, "state.json");
			const raw = fs.readFileSync(statePath, "utf-8");
			const st = JSON.parse(raw) as { startedAtEpochMs?: number };
			startEpoch = st.startedAtEpochMs ?? Date.now();
		} catch {
			startEpoch = Date.now();
		}
	}

	skillLog.logRunEnd({
		runId: currentRunId,
		durationMs: Date.now() - startEpoch,
		successCount,
		failCount,
		totalRepos,
		totalRetries,
		loopCount,
	});
	skillLog.logOrderFinished({
		runId: currentRunId,
		outcome: failCount > 0 ? "failed" : "success",
		successCount,
		failCount,
		totalRepos,
		totalRetries,
	});

	releaseLockAndTriggerNext(io.runId);

	const hasFailedRepo = failCount > 0;
	if (hasFailedRepo) {
		return io.fail(
			new Error(
				"One or more repositories failed to publish commits. Check report.",
			),
		);
	}

	return io.done({});
}
