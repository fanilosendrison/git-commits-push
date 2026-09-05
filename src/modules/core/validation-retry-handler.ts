import type { CommitPlan, RepoState, Settings } from "../../types.ts";
import type { SkillStatsLog } from "../telemetry/stats-events.ts";
import { collectCommitMessageValidationErrors } from "./commit-message-validation.ts";
import { buildFallbackSettings, shouldUseFallback } from "./fallback-model.ts";
import {
	MAX_ATTEMPTS_BY_KIND,
	type QueueRetryResult,
	queueRetry,
} from "./queue-retry.ts";

export interface ValidationRetryHandlingResult {
	readonly handled: boolean;
	readonly repoState: RepoState;
	readonly loopCountDelta: number;
}

interface ValidationRetryHandlingOptions {
	readonly repoId: string;
	readonly repoState: RepoState;
	readonly plans: CommitPlan[];
	readonly settings: Settings;
	readonly systemPrompt: string;
	readonly runId: string;
	readonly skillLog: SkillStatsLog;
}

function totalRetries(repoState: RepoState): number {
	return Object.values(repoState.attempts ?? {}).reduce(
		(sum, count) => sum + count,
		0,
	);
}

function logFailure(
	options: ValidationRetryHandlingOptions,
	repoState: RepoState,
	error: string,
): void {
	options.skillLog.logRepoOutcome({
		runId: options.runId,
		repoId: options.repoId,
		repository: repoState.repository,
		status: "FAILED",
		error,
		attempts: repoState.attempts ?? {},
		totalRetries: totalRetries(repoState),
		committedCount: repoState.committedShas?.length ?? 0,
	});
}

function logDelegation(
	options: ValidationRetryHandlingOptions,
	repoState: RepoState,
	retryResult: QueueRetryResult & { kind: "queued" },
	settings: Settings,
	attempt: number,
	retryReason?: string,
): void {
	options.skillLog.logDelegation({
		runId: options.runId,
		repoId: options.repoId,
		repository: repoState.repository,
		isRetry: true,
		retryKind: "validation",
		attempt,
		model: settings.model,
		thinking: settings.thinking ?? false,
		diffHash: retryResult.repoState.diffHash ?? "",
		...(retryReason ? { retryReason } : {}),
		diffSizeBytes: null,
		previousDiffHash: repoState.diffHash ?? "",
		diffChanged: false,
		pendingFilesCount: null,
		feedbackHistoryItems: (retryResult.repoState.feedbackHistory ?? []).length,
	});
}

/** Apply the bounded primary/fallback policy for invalid commit messages. */
export function handleValidationRetry(
	options: ValidationRetryHandlingOptions,
): ValidationRetryHandlingResult {
	const validationErrors = collectCommitMessageValidationErrors(options.plans);
	if (validationErrors.length === 0) {
		return { handled: false, repoState: options.repoState, loopCountDelta: 0 };
	}

	let repoState = options.repoState;
	const validationAttempts = repoState.attempts?.validation ?? 0;
	if (repoState.fallbackAttempted) {
		const error = `Validation failed after fallback repair: ${validationErrors
			.map((entry) => entry.message)
			.join(", ")}`;
		repoState = { ...repoState, status: "FAILED", error };
		logFailure(options, repoState, error);
		return { handled: true, repoState, loopCountDelta: 0 };
	}

	if (validationAttempts < MAX_ATTEMPTS_BY_KIND.validation) {
		repoState = {
			...repoState,
			attempts: {
				...(repoState.attempts ?? {}),
				validation: validationAttempts + 1,
			},
		};
		const retryResult = queueRetry(
			options.repoId,
			repoState,
			validationErrors,
			{},
			options.settings,
			options.systemPrompt,
			options.plans,
		);
		if (retryResult.kind === "queued") {
			logDelegation(
				options,
				repoState,
				retryResult,
				options.settings,
				validationAttempts + 1,
				validationErrors
					.map((error) => error.message)
					.join("; ")
					.slice(0, 200),
			);
			return {
				handled: true,
				repoState: retryResult.repoState,
				loopCountDelta: 0,
			};
		}

		options.skillLog.logLoopDetected({
			runId: options.runId,
			repoId: options.repoId,
			kind: "validation",
			planHash: retryResult.repoState.lastPlanHash ?? "",
		});
		if (
			shouldUseFallback(
				options.settings,
				"validation",
				MAX_ATTEMPTS_BY_KIND.validation,
				false,
			)
		) {
			const fallbackSettings = buildFallbackSettings(options.settings);
			const fallbackRetry = queueRetry(
				options.repoId,
				{
					...retryResult.repoState,
					fallbackAttempted: true,
					lastPlanHash: undefined,
					attempts: {
						...(retryResult.repoState.attempts ?? {}),
						validation: 0,
					},
				},
				validationErrors,
				{},
				fallbackSettings,
				options.systemPrompt,
				options.plans,
			);
			if (fallbackRetry.kind === "queued") {
				logDelegation(
					options,
					repoState,
					fallbackRetry,
					fallbackSettings,
					1,
					"Identical primary commit-message repair",
				);
				return {
					handled: true,
					repoState: fallbackRetry.repoState,
					loopCountDelta: 1,
				};
			}
		}
		return {
			handled: true,
			repoState: {
				...retryResult.repoState,
				status: "FAILED",
				error:
					"Loop detected: LLM returned an identical commit-message repair.",
				loopDetected: {
					kind: "validation",
					planHash: retryResult.repoState.lastPlanHash ?? "",
				},
			},
			loopCountDelta: 1,
		};
	}

	if (
		shouldUseFallback(options.settings, "validation", validationAttempts, false)
	) {
		const fallbackSettings = buildFallbackSettings(options.settings);
		const fallbackRetry = queueRetry(
			options.repoId,
			{
				...repoState,
				fallbackAttempted: true,
				lastPlanHash: undefined,
				attempts: { ...(repoState.attempts ?? {}), validation: 0 },
			},
			validationErrors,
			{},
			fallbackSettings,
			options.systemPrompt,
			options.plans,
		);
		if (fallbackRetry.kind === "queued") {
			logDelegation(options, repoState, fallbackRetry, fallbackSettings, 1);
			return {
				handled: true,
				repoState: fallbackRetry.repoState,
				loopCountDelta: 0,
			};
		}
		return {
			handled: true,
			repoState: {
				...fallbackRetry.repoState,
				status: "FAILED",
				error: "Loop detected after fallback: LLM returned an identical plan.",
			},
			loopCountDelta: 0,
		};
	}

	return {
		handled: true,
		repoState: {
			...repoState,
			status: "FAILED",
			error: `Validation failed after max retries: ${validationErrors
				.map((error) => error.message)
				.join(", ")}`,
		},
		loopCountDelta: 0,
	};
}
