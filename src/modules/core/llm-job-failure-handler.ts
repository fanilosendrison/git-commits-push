import type { CommitJobResultError, RepoState, Settings } from "../../types.ts";
import type { SkillStatsLog } from "../telemetry/stats-logger.ts";
import { classifyLLMFailure } from "./error-classifier.ts";
import { MAX_ATTEMPTS_BY_KIND, queueRetry } from "./queue-retry.ts";
import { sanitizeSensitiveDiagnostic } from "./sensitive-diagnostic-sanitizer.ts";

interface LlmJobFailureOptions {
	readonly result: CommitJobResultError;
	readonly repoState: RepoState;
	readonly runId: string;
	readonly settings: Settings;
	readonly skillLog: SkillStatsLog;
	readonly systemPrompt: string;
}

function retryCount(repoState: RepoState): number {
	return Object.values(repoState.attempts ?? {}).reduce(
		(total, count) => total + count,
		0,
	);
}

export function handleLlmJobFailure({
	result,
	repoState,
	runId,
	settings,
	skillLog,
	systemPrompt,
}: LlmJobFailureOptions): RepoState {
	const llmError = sanitizeSensitiveDiagnostic(result.error);
	const llmKind = classifyLLMFailure(llmError);
	if (llmKind === null) {
		const isLlmEmptyPlans =
			llmError.includes("empty") || llmError.includes("non-empty JSON array");
		if (isLlmEmptyPlans && (repoState.committedShas?.length ?? 0) > 0) {
			return {
				...repoState,
				status: "SUCCESS",
				commits: [],
				error:
					"LLM returned an empty plan after partial commits completed; treating as success.",
			};
		}
		skillLog.logRepoOutcome({
			runId,
			repoId: result.id,
			repository: repoState.repository,
			status: "FAILED",
			error: llmError,
			attempts: repoState.attempts ?? {},
			totalRetries: retryCount(repoState),
			committedCount: 0,
		});
		return {
			...repoState,
			status: "FAILED",
			error: `LLM fatal error: ${llmError}`,
		};
	}

	const attempts = repoState.attempts?.[llmKind] ?? 0;
	if (attempts < MAX_ATTEMPTS_BY_KIND[llmKind]) {
		const incrementedState: RepoState = {
			...repoState,
			attempts: {
				...(repoState.attempts ?? {}),
				[llmKind]: attempts + 1,
			},
		};
		const retryResult = queueRetry(
			result.id,
			incrementedState,
			[
				{
					kind: llmKind,
					message: llmError,
					resolution_hint:
						"The previous LLM response was malformed. Regenerate based on the current diff.",
				},
			],
			{},
			settings,
			systemPrompt,
			[],
		);
		if (retryResult.kind === "loop-detected") {
			skillLog.logLoopDetected({
				runId,
				repoId: result.id,
				kind: llmKind,
				planHash: retryResult.repoState.lastPlanHash ?? "",
			});
			return {
				...retryResult.repoState,
				status: "FAILED",
				error: "Loop detected after LLM-side failure.",
			};
		}
		skillLog.logDelegation({
			runId,
			repoId: result.id,
			repository: incrementedState.repository,
			isRetry: true,
			retryKind: llmKind,
			attempt: attempts + 1,
			model: settings.model,
			thinking: settings.thinking ?? false,
			diffHash: retryResult.repoState.diffHash ?? "",
			retryReason: llmError.slice(0, 200),
			diffSizeBytes: null,
			previousDiffHash: incrementedState.diffHash ?? "",
			diffChanged:
				(incrementedState.diffHash ?? "") !==
				(retryResult.repoState.diffHash ?? ""),
			pendingFilesCount: null,
			feedbackHistoryItems: (incrementedState.feedbackHistory ?? []).length,
		});
		return retryResult.repoState;
	}

	skillLog.logRepoOutcome({
		runId,
		repoId: result.id,
		repository: repoState.repository,
		status: "FAILED",
		error: llmError,
		attempts: repoState.attempts ?? {},
		totalRetries: retryCount(repoState),
		committedCount: repoState.committedShas?.length ?? 0,
	});
	return {
		...repoState,
		status: "FAILED",
		error: `LLM fatal error after max retries: ${llmError}`,
	};
}
