import type { InvocationScope, RepoState } from "../../types.ts";
import type { classifyError } from "../core/error-classifier.ts";
import { assertCreationAncestry } from "./creation-local-objects.ts";
import { readHeadSha } from "./explicit-push-target.ts";

/** A creation race or absent publication proof cannot authorize a fresh plan. */
export function creationRetryStopReason(
	scope: InvocationScope,
	committed: boolean,
	classified: ReturnType<typeof classifyError>,
): string | undefined {
	if (scope.kind !== "targeted-create") return undefined;
	if (committed)
		return "Creation stopped without exact publication proof; landed commits are preserved and must not be replanned.";
	if (classified.error.kind === "race")
		return "Creation worktree or index changed after validation; refusing to replan unvalidated content.";
	return undefined;
}

/** Refuse dirty-run replanning when any commit identity can no longer be bound to admission. */
export function creationResumeStopReason(repo: RepoState): string | null {
	if (repo.operation === "push-only") return null;
	const target = repo.explicitPushTargetSnapshot;
	if (!target || !("kind" in target))
		return "Creation resume lacks its frozen authority.";
	if (
		repo.committedShas?.length ||
		readHeadSha(repo.repository) !== target.initialHeadSha
	)
		return "Interrupted creation commits are preserved; validated final identity is not durably provable, so replanning/publication is refused.";
	try {
		assertCreationAncestry(
			repo.repository,
			target.baseSha,
			target.observedBaseRefSha,
		);
		assertCreationAncestry(
			repo.repository,
			target.baseSha,
			target.initialHeadSha,
		);
	} catch (error) {
		return error instanceof Error
			? error.message
			: "Creation anchor cannot be revalidated.";
	}
	return null;
}
