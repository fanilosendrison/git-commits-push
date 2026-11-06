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

/** Persist exact success/failure evidence through Turnlock before terminal reporting. */
export function checkpointCreationOutcome(
	state: GlobalState,
	repos: Record<string, RepoState>,
	io: PhaseIO<GlobalState>,
): PhaseResult<GlobalState, unknown> {
	const terminalRepos = Object.fromEntries(
		Object.entries(repos).map(([id, repo]) => [
			id,
			repo.status === "SUCCESS" || repo.status === "FAILED"
				? repo
				: {
						...repo,
						status: "FAILED" as const,
						error: "Creation has no completed exact publication evidence.",
					},
		]),
	);
	const nextState = stateSchema.parse({ ...state, repos: terminalRepos });
	const entries = Object.entries(nextState.repos);
	const entry = entries[0];
	if (
		state.invocationScope.kind !== "targeted-create" ||
		entries.length !== 1 ||
		!entry
	)
		return io.fail(
			new Error(
				"Creation outcome requires exactly one caller-owned repository.",
			),
		);
	const payload: PublicationCheckpointPayload = {
		mode: "checkpoint-creation-outcome",
		repository: entry[1].repository,
	};
	return io.delegateBatch(
		{
			kind: "batch",
			target: { kind: "worker", name: "git-commit-generator" },
			label: "creation-outcome",
			jobs: [{ id: entry[0], prompt: JSON.stringify(payload) }],
			timeout: { perDelegationMs: 600_000 },
			retry: { maxAttempts: 1, backoffBaseMs: 1000, maxBackoffMs: 30000 },
		},
		"creation-outcome",
		nextState,
	);
}

/** No Git or LLM work: a resumed terminal checkpoint only reports persisted evidence. */
export async function finalizeCreationOutcomePhase(
	state: GlobalState,
	io: PhaseIO<GlobalState>,
): Promise<PhaseResult<GlobalState, unknown>> {
	const validated = stateSchema.parse(state);
	if (validated.invocationScope.kind !== "targeted-create")
		return io.fail(
			new Error("Creation outcome phase requires creation authority."),
		);
	const results = io.consumePendingBatchResults(commitJobResultSchema);
	const ids = Object.keys(validated.repos);
	if (
		ids.length !== 1 ||
		results.length !== 1 ||
		results[0]?.id !== ids[0] ||
		!results[0]?.success ||
		Object.values(validated.repos).some(
			(repo) => repo.status !== "SUCCESS" && repo.status !== "FAILED",
		)
	)
		return io.fail(
			new Error(
				"Creation outcome checkpoint acknowledgement or terminal evidence is missing.",
			),
		);
	return finalizeCommitPushPhase(
		validated.repos,
		io,
		io.runId,
		0,
		createSkillStatsLog(),
	);
}
