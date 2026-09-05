import type { CommitJobResult, RepoState, Settings } from "../../types.ts";
import { sanitizeSensitiveDiagnostic } from "../core/sensitive-diagnostic-sanitizer.ts";
import type { SkillStatsLog } from "../telemetry/stats-events.ts";
import { validateAndPushTrackedSnapshot } from "./push-only.ts";

interface PushOnlyCheckpointHandlingOptions {
	readonly repoId: string;
	readonly repoState: RepoState;
	readonly result: CommitJobResult;
	readonly runId: string;
	readonly settings: Settings;
	readonly skillLog: Pick<SkillStatsLog, "logRepoOutcome">;
}

/** Resume one durably checkpointed push-only publication idempotently. */
export async function handlePushOnlyCheckpointResult(
	options: PushOnlyCheckpointHandlingOptions,
): Promise<RepoState> {
	const snapshot = options.repoState.pushSnapshot;
	if (!snapshot) {
		throw new Error(
			"Persisted push-only state is missing its tracked snapshot.",
		);
	}

	try {
		if (!options.result.success) {
			throw new Error(options.result.error);
		}
		if (!options.settings.autoPush) {
			throw new Error(
				"Push-only publication was checkpointed but autoPush is now disabled.",
			);
		}
		const pushedShas = await validateAndPushTrackedSnapshot(
			{
				id: options.repoId,
				path: options.repoState.repository,
				operation: "push-only",
				pushSnapshot: snapshot,
			},
			snapshot,
			options.settings,
		);
		if (
			pushedShas.length !== snapshot.outgoingShas.length ||
			pushedShas.some((sha, index) => sha !== snapshot.outgoingShas[index])
		) {
			throw new Error(
				"Push-only publication did not return the complete checkpointed object set.",
			);
		}
		const successState: RepoState = {
			...options.repoState,
			status: "SUCCESS",
			operation: "push-only",
			pushSnapshot: snapshot,
			pushedShas,
		};
		options.skillLog.logRepoOutcome({
			runId: options.runId,
			repoId: options.repoId,
			repository: options.repoState.repository,
			status: "SUCCESS",
			attempts: options.repoState.attempts ?? {},
			totalRetries: 0,
			committedCount: 0,
		});
		return successState;
	} catch (error) {
		const message = sanitizeSensitiveDiagnostic(
			error instanceof Error ? error.message : String(error),
		);
		const failedState: RepoState = {
			...options.repoState,
			status: "FAILED",
			operation: "push-only",
			pushSnapshot: snapshot,
			error: message,
		};
		options.skillLog.logRepoOutcome({
			runId: options.runId,
			repoId: options.repoId,
			repository: options.repoState.repository,
			status: "FAILED",
			error: message,
			attempts: options.repoState.attempts ?? {},
			totalRetries: 0,
			committedCount: 0,
		});
		return failedState;
	}
}
