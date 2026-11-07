import type {
	CommitPlan,
	FeedbackError,
	RepoState,
	Settings,
} from "../../types.ts";
import type { SkillStatsLog } from "../telemetry/stats-events.ts";
import { queueRetry } from "./queue-retry.ts";

/** Queue a budgeted structural/Git retry without losing effects if source qualification fails. */
export function retryPublicationPlan(options: {
	repoId: string;
	repo: RepoState;
	error: FeedbackError;
	pendingFiles: string[] | undefined;
	settings: Settings;
	systemPrompt: string;
	plans: CommitPlan[];
	runId: string;
	skillLog: SkillStatsLog;
}): RepoState {
	const {
		repoId,
		repo,
		error,
		pendingFiles,
		settings,
		systemPrompt,
		plans,
		runId,
		skillLog,
	} = options;
	const attempt = (repo.attempts?.[error.kind] ?? 0) + 1;
	const incremented = {
		...repo,
		attempts: { ...repo.attempts, [error.kind]: attempt },
	};
	try {
		const retry = queueRetry(
			repoId,
			incremented,
			[error],
			{ committedShas: repo.committedShas, pendingFiles },
			settings,
			systemPrompt,
			plans,
		);
		if (retry.kind === "loop-detected") {
			const loopDetected = {
				kind: error.kind,
				planHash: retry.repoState.lastPlanHash ?? "",
			};
			skillLog.logLoopDetected({ runId, repoId, ...loopDetected });
			skillLog.logRepoOutcome({
				runId,
				repoId,
				repository: repo.repository,
				status: "FAILED",
				error: `Loop detected for kind ${error.kind}`,
				attempts: incremented.attempts,
				totalRetries: Object.values(incremented.attempts).reduce(
					(sum, count) => sum + count,
					0,
				),
				loopDetected,
				committedCount: repo.committedShas?.length ?? 0,
			});
			return {
				...retry.repoState,
				status: "FAILED",
				loopDetected,
				error: `Loop detected: LLM returned an identical plan on two consecutive attempts for kind "${error.kind}".`,
			};
		}
		skillLog.logDelegation({
			runId,
			repoId,
			repository: repo.repository,
			isRetry: true,
			retryKind: error.kind,
			attempt,
			model: settings.model,
			thinking: settings.thinking ?? false,
			diffHash: retry.repoState.diffHash ?? "",
			diffSizeBytes: null,
			previousDiffHash: repo.diffHash ?? "",
			diffChanged: repo.diffHash !== retry.repoState.diffHash,
			pendingFilesCount: pendingFiles?.length ?? null,
			feedbackHistoryItems: repo.feedbackHistory?.length ?? 0,
		});
		return retry.repoState;
	} catch (failure) {
		return {
			...incremented,
			status: "FAILED",
			error: failure instanceof Error ? failure.message : String(failure),
		};
	}
}
