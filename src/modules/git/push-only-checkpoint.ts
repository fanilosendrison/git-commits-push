import type { CommitJobResult, RepoState, Settings } from "../../types.ts";
import { sanitizeSensitiveDiagnostic } from "../core/sensitive-diagnostic-sanitizer.ts";
import type { SkillStatsLog } from "../telemetry/stats-events.ts";
import { validateAndPushExplicitSnapshot } from "./explicit-push.ts";
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
		throw new Error("Persisted push-only state is missing its push snapshot.");
	}

	// A recorded successful creation is terminal, not authority to recreate a deleted ref.
	if (
		snapshot.kind === "explicit-create" &&
		options.repoState.status === "SUCCESS"
	)
		return options.repoState;
	return snapshot.kind === "tracked"
		? await resumeTrackedPushOnly(options, snapshot)
		: await resumeExplicitPushOnly(options, snapshot);
}

async function resumeTrackedPushOnly(
	options: PushOnlyCheckpointHandlingOptions,
	snapshot: Extract<RepoState["pushSnapshot"], { kind: "tracked" }>,
): Promise<RepoState> {
	try {
		if (!options.result.success) {
			throw new Error(options.result.error);
		}
		if (!options.settings.autoPush) {
			throw new Error(
				"Push-only publication was checkpointed but autoPush is now disabled.",
			);
		}
		const { pushedShas, publishedSha, remoteTrackingRefSynchronization } =
			await validateAndPushTrackedSnapshot(
				{
					id: options.repoId,
					path: options.repoState.repository,
					operation: "push-only",
					pushSnapshot: snapshot,
				},
				snapshot,
				options.settings,
			);
		assertCompleteObjectSet(pushedShas, snapshot.outgoingShas);
		const successState: RepoState = {
			...options.repoState,
			status: "SUCCESS",
			operation: "push-only",
			pushSnapshot: snapshot,
			pushedShas,
			publishedSha: publishedSha ?? undefined,
			remoteTrackingRefSynchronization:
				remoteTrackingRefSynchronization ?? undefined,
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

/**
 * Resume a checkpointed explicit-target publication. The named destination and
 * its frozen baseline are the whole authority, so `autoPush` is never consulted
 * and no local tracking projection is created.
 */
async function resumeExplicitPushOnly(
	options: PushOnlyCheckpointHandlingOptions,
	snapshot: Extract<
		RepoState["pushSnapshot"],
		{ kind: "explicit" | "explicit-create" }
	>,
): Promise<RepoState> {
	try {
		if (!options.result.success) {
			throw new Error(options.result.error);
		}
		const { pushedShas, publishedSha, remoteTrackingRefSynchronization } =
			await validateAndPushExplicitSnapshot(
				{
					id: options.repoId,
					path: options.repoState.repository,
					operation: "push-only",
					pushSnapshot: snapshot,
				},
				snapshot,
				options.settings,
			);
		assertCompleteObjectSet(pushedShas, snapshot.outgoingShas);
		if (remoteTrackingRefSynchronization !== "not-applicable") {
			throw new Error(
				"Explicit publication must not report a remote-tracking projection outcome.",
			);
		}
		const successState: RepoState = {
			...options.repoState,
			status: "SUCCESS",
			operation: "push-only",
			pushSnapshot: snapshot,
			pushedShas,
			publishedSha,
			remoteTrackingRefSynchronization: "not-applicable",
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

function assertCompleteObjectSet(
	pushedShas: readonly string[],
	expectedShas: readonly string[],
): void {
	if (
		pushedShas.length !== expectedShas.length ||
		pushedShas.some((sha, index) => sha !== expectedShas[index])
	) {
		throw new Error(
			"Push-only publication did not return the complete checkpointed object set.",
		);
	}
}
