import type { CommitJobResultError, RepoState, Settings } from "../../types.ts";
import type { SkillStatsLog } from "../telemetry/stats-logger.ts";
import { classifyLLMFailure } from "./error-classifier.ts";
import { buildFallbackSettings, shouldUseFallback } from "./fallback-model.ts";
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
	const llmKind = result.providerFailureKind
		? shouldUseFallback(
				settings,
				"provider",
				repoState.attempts?.provider ?? 0,
				repoState.fallbackAttempted ?? false,
			)
			? "provider"
			: null
		: classifyLLMFailure(llmError);
	const retrySettings =
		llmKind === "provider" ? buildFallbackSettings(settings) : settings;
	if (llmKind === null) {
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
			error: `LLM fatal error: ${llmError}`,
		};
	}

	const attempts = repoState.attempts?.[llmKind] ?? 0;
	if (attempts < MAX_ATTEMPTS_BY_KIND[llmKind]) {
		const incrementedState: RepoState = {
			...repoState,
			...(llmKind === "provider"
				? { fallbackAttempted: true, lastPlanHash: undefined }
				: {}),
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
					kind: result.rejectedPlans ? "validation" : llmKind,
					message: llmError,
					resolution_hint:
						llmKind === "provider"
							? "The primary provider is unavailable. Use the configured fallback for pending work only."
							: "The previous LLM response was malformed. Regenerate based on the current diff.",
				},
			],
			{},
			retrySettings,
			systemPrompt,
			result.rejectedPlans ?? [],
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
			model: retrySettings.model,
			thinking: retrySettings.thinking ?? false,
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
