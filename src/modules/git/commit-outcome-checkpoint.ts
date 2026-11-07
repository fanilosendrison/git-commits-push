import type { PhaseIO, PhaseResult } from "turnlock";
import {
	commitJobResultSchema,
	stateSchema,
} from "../../config/state-schema.ts";
import type {
	GlobalState,
	PublicationCheckpointPayload,
	RepoState,
} from "../../types.ts";
import { finalizeCommitPushPhase } from "../core/commit-push-finalizer.ts";
import { createSkillStatsLog } from "../telemetry/stats-logger.ts";
import { qualifyCommitOutcomes } from "./commit-completion.ts";

/** Persist terminal commit evidence before a no-effect reporting continuation. */
export function checkpointCommitOutcome(
	state: GlobalState,
	repos: Record<string, RepoState>,
	io: PhaseIO<GlobalState>,
): PhaseResult<GlobalState, unknown> {
	if (
		state.invocationScope.kind !== "worktree" &&
		state.invocationScope.kind !== "targeted"
	)
		return io.fail(
			new Error(
				"Commit outcome requires executable worktree or targeted authority.",
			),
		);
	const next = stateSchema.parse({
		...state,
		repos: qualifyCommitOutcomes(repos),
	});
	const jobs = Object.entries(next.repos).map(([id, repo]) => {
		const payload: PublicationCheckpointPayload = {
			mode: "checkpoint-commit-outcome",
			repository: repo.repository,
		};
		return { id, prompt: JSON.stringify(payload) };
	});
	if (!jobs.length)
		return io.fail(new Error("Commit outcome has no repository evidence."));
	return io.delegateBatch(
		{
			kind: "batch",
			target: { kind: "worker", name: "git-commit-generator" },
			label: "commit-outcome",
			jobs,
			timeout: { perDelegationMs: 600_000 },
			retry: { maxAttempts: 1, backoffBaseMs: 1000, maxBackoffMs: 30000 },
		},
		"commit-outcome",
		next,
	);
}

/** Reporting interrupted after this checkpoint never causes another Git publication. */
export async function finalizeCommitOutcomePhase(
	state: GlobalState,
	io: PhaseIO<GlobalState>,
): Promise<PhaseResult<GlobalState, unknown>> {
	const validated = stateSchema.parse(state);
	if (
		validated.invocationScope.kind !== "worktree" &&
		validated.invocationScope.kind !== "targeted"
	)
		return io.fail(
			new Error(
				"Commit outcome requires executable worktree or targeted authority.",
			),
		);
	const results = io.consumePendingBatchResults(commitJobResultSchema);
	const ids = Object.keys(validated.repos);
	if (
		results.length !== ids.length ||
		new Set(results.map((result) => result.id)).size !== ids.length ||
		results.some((result) => !result.success || !ids.includes(result.id))
	)
		return io.fail(
			new Error("Commit outcome acknowledgement missing or incoherent."),
		);
	return finalizeCommitPushPhase(
		validated.repos,
		io,
		io.runId,
		0,
		createSkillStatsLog(),
	);
}
