import { isFullGitObjectId } from "../modules/git/git-object-id.ts";
import type { InvocationScope, RepoState } from "../types.ts";

type StateIssue = (message: string, field: string) => void;

/** Cross-field creation authority and success evidence; never repair persisted data. */
export function validateCreationStateRelations(
	scope: InvocationScope,
	repo: RepoState,
	issue: StateIssue,
): void {
	const target = repo.explicitPushTargetSnapshot;
	const push = repo.pushSnapshot;
	const creationTarget = target && "kind" in target ? target : undefined;
	const creationPush = push?.kind === "explicit-create" ? push : undefined;
	const final = repo.creationPublicationSnapshot;
	if (scope.kind !== "targeted-create") {
		if (creationTarget || creationPush || final)
			issue(
				"creation evidence requires targeted-create authority",
				"invocationScope",
			);
		return;
	}
	if (scope.baseRef === scope.pushRef || scope.pushRemote === ".")
		issue(
			"creation requires distinct source/destination refs and a configured remote",
			"invocationScope",
		);
	if (repo.operation === "push-only") {
		if (!creationPush || final)
			issue(
				"creation push-only state requires its explicit-create snapshot exclusively",
				"pushSnapshot",
			);
	} else if (repo.operation === "commit-and-push") {
		if (!creationTarget || creationPush)
			issue(
				"creation commit-and-push requires its frozen creation target",
				"explicitPushTargetSnapshot",
			);
	} else
		issue("creation requires an explicit repository operation", "operation");
	for (const [field, snapshot] of [
		["explicitPushTargetSnapshot", creationTarget],
		["pushSnapshot", creationPush],
		["creationPublicationSnapshot", final],
	] as const) {
		if (!snapshot) continue;
		if (
			snapshot.remote !== scope.pushRemote ||
			snapshot.destinationRef !== scope.pushRef ||
			snapshot.baseRef !== scope.baseRef ||
			snapshot.baseSha !== scope.baseSha ||
			snapshot.observedBaseRefSha.length !== scope.baseSha.length ||
			("initialHeadSha" in snapshot &&
				snapshot.initialHeadSha.length !== scope.baseSha.length)
		)
			issue(
				"creation snapshot must match its exact persisted authority",
				field,
			);
		if (
			creationTarget &&
			(snapshot.observedBaseRefSha !== creationTarget.observedBaseRefSha ||
				snapshot.pushUrlFingerprint !== creationTarget.pushUrlFingerprint)
		)
			issue(
				"final creation evidence must retain the admission anchor and endpoint",
				field,
			);
		if ("outgoingShas" in snapshot) {
			const shas = snapshot.outgoingShas;
			if (
				new Set(shas).size !== shas.length ||
				shas.some(
					(sha) => sha.length !== scope.baseSha.length || sha === scope.baseSha,
				) ||
				(shas.length === 0
					? snapshot.validatedHeadSha !== scope.baseSha
					: shas.at(-1) !== snapshot.validatedHeadSha)
			)
				issue(
					"creation outgoing history must bind B to its exact final identity",
					field,
				);
		}
	}
	if (target && !creationTarget)
		issue(
			"creation must not carry an update destination baseline",
			"explicitPushTargetSnapshot",
		);
	if (push && !creationPush)
		issue(
			"creation must not carry a historical publication snapshot",
			"pushSnapshot",
		);
	if (
		creationTarget &&
		repo.originalHead !== undefined &&
		repo.originalHead !== creationTarget.initialHeadSha
	)
		issue(
			"creation original HEAD must match its admission identity",
			"originalHead",
		);
	const validated = creationPush ?? final;
	if (
		repo.publishedSha !== undefined &&
		(!validated || repo.publishedSha !== validated.validatedHeadSha)
	)
		issue(
			"creation publication evidence must match its validated final identity",
			"publishedSha",
		);
	if (
		repo.remoteTrackingRefSynchronization !== undefined &&
		repo.remoteTrackingRefSynchronization !== "not-applicable"
	)
		issue(
			"creation cannot carry a local tracking projection",
			"remoteTrackingRefSynchronization",
		);
	if (
		repo.committedShas?.some(
			(commit) =>
				!isFullGitObjectId(commit.sha) ||
				commit.sha.length !== scope.baseSha.length,
		)
	)
		issue(
			"creation commit evidence requires full repository-format object IDs",
			"committedShas",
		);
	if (
		final &&
		(repo.committedShas?.at(-1)?.sha !== final.validatedHeadSha ||
			repo.committedShas?.some(
				(commit) => !final.outgoingShas.includes(commit.sha),
			))
	)
		issue(
			"dirty creation must bind preserved commits to its validated final identity",
			"committedShas",
		);
	if (
		repo.status === "SUCCESS" &&
		(!validated ||
			repo.publishedSha === undefined ||
			repo.remoteTrackingRefSynchronization !== "not-applicable")
	)
		issue(
			"successful creation requires validated final identity and exact publication proof",
			"publishedSha",
		);
}
