import { isDeepStrictEqual } from "node:util";
import type { PhaseIO, PhaseResult } from "turnlock";
import { z } from "zod";
import { stateSchema } from "../config/state-schema.ts";
import { finalizeCommitPushPhase } from "../modules/core/commit-push-finalizer.ts";
import { assertCommitCompletion } from "../modules/git/commit-completion.ts";
import { assertEstablishedPreparedMerge } from "../modules/git/prepared-merge-publisher.ts";
import { validatePreparedMerge } from "../modules/git/prepared-merge-validation.ts";
import { assertInvocationScopeCurrent } from "../modules/invocation/invocation-scope.ts";
import { createSkillStatsLog } from "../modules/telemetry/stats-logger.ts";
import {
	consumePreparedMergeResolution,
	PREPARED_MERGE_REQUEST_TYPES,
	type PreparedMergeRequestKind,
	preparedMergeRequestPayload,
} from "../modules/turnlock/prepared-merge-request.ts";
import type { GlobalState, RepoState, Settings } from "../types.ts";
import { computeRepoId } from "../utils/git-utils.ts";

function request(
	state: GlobalState,
	io: PhaseIO<GlobalState>,
	kind: PreparedMergeRequestKind,
	resumeAt: string,
): PhaseResult<GlobalState, unknown> {
	const next = stateSchema.parse(state);
	return io.requestExternal(
		{
			label: `prepared-merge-${kind}`,
			requestType: PREPARED_MERGE_REQUEST_TYPES[kind],
			payload: preparedMergeRequestPayload(next),
		},
		resumeAt,
		next,
	);
}

function consume(state: GlobalState, io: PhaseIO<GlobalState>): GlobalState {
	stateSchema.parse(state);
	assertInvocationScopeCurrent(state.invocationScope);
	return consumePreparedMergeResolution(
		state,
		io.consumePendingExternalResolution(z.unknown()),
	);
}

function report(
	state: GlobalState,
	io: PhaseIO<GlobalState>,
): PhaseResult<GlobalState, unknown> {
	return request(state, io, "report", "prepared-merge-outcome");
}
function fail(
	state: GlobalState,
	io: PhaseIO<GlobalState>,
	error: unknown,
): PhaseResult<GlobalState, unknown> {
	const repos = Object.fromEntries(
		Object.entries(state.repos).map(([id, repo]) => [
			id,
			{
				...repo,
				status: "FAILED" as const,
				error: error instanceof Error ? error.message : String(error),
			},
		]),
	);
	return report({ ...state, repos }, io);
}

/** Capture once; Turnlock suspends before the consumer can create any commit object. */
export async function prepareMergePublication(
	state: GlobalState,
	io: PhaseIO<GlobalState>,
	settings: Settings,
): Promise<PhaseResult<GlobalState, unknown>> {
	const scope = state.invocationScope;
	if (scope.kind !== "prepared-merge")
		return io.fail(new Error("Missing prepared merge authority."));
	assertInvocationScopeCurrent(scope);
	const { witness, target } = await validatePreparedMerge(scope, settings);
	const id = await computeRepoId(scope.repository);
	const repo: RepoState = {
		repository: scope.repository,
		operation: "commit-and-push",
		status: "RUNNING",
		validatedSource: witness,
		explicitPushTargetSnapshot: target,
	};
	return request(
		{ ...state, repos: { [id]: repo } },
		io,
		"commit",
		"prepared-merge-commit",
	);
}

/** Consume the pinned external commit resolution, then durably request publication of exact M. */
export async function commitPreparedMergePhase(
	state: GlobalState,
	io: PhaseIO<GlobalState>,
): Promise<PhaseResult<GlobalState, unknown>> {
	const next = consume(state, io);
	const repo = Object.values(next.repos)[0];
	if (!repo || next.invocationScope.kind !== "prepared-merge")
		return io.fail(new Error("Missing prepared merge result."));
	if (repo.status === "FAILED") return report(next, io);
	try {
		assertEstablishedPreparedMerge(next.invocationScope, repo);
		return request(next, io, "publish", "prepared-merge-publish");
	} catch (error) {
		return fail(next, io, error);
	}
}

/** Consume an opaque pinned publication result; this phase never pushes. */
export async function publishPreparedMergePhase(
	state: GlobalState,
	io: PhaseIO<GlobalState>,
): Promise<PhaseResult<GlobalState, unknown>> {
	const next = consume(state, io);
	const repo = Object.values(next.repos)[0];
	if (!repo) return io.fail(new Error("Missing exact publication result."));
	try {
		if (repo.status !== "FAILED") assertCommitCompletion(repo);
		return report(next, io);
	} catch (error) {
		return fail(next, io, error);
	}
}

/** Reporting-only request/resolution preserves terminal evidence and can never republish. */
export async function finalizePreparedMergePhase(
	state: GlobalState,
	io: PhaseIO<GlobalState>,
): Promise<PhaseResult<GlobalState, unknown>> {
	const next = consume(state, io);
	if (!isDeepStrictEqual(next, state))
		return io.fail(
			new Error("Reporting cannot redefine prepared publication evidence."),
		);
	return finalizeCommitPushPhase(
		next.repos,
		io,
		io.runId,
		0,
		createSkillStatsLog(),
	);
}
