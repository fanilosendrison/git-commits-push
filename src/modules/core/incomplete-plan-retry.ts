import type { CommitPlan, FeedbackError, RepoState } from "../../types.ts";

/** No complete aggregate means no new plan fingerprint, not new retry authority. */
export function assertIncompletePlanRetry(
	repo: RepoState,
	errors: readonly FeedbackError[],
	plans: readonly CommitPlan[],
	maximum: Readonly<Record<FeedbackError["kind"], number>>,
): void {
	const kind = errors[0]?.kind;
	if (
		(kind !== "structural" && kind !== "provider") ||
		plans.length ||
		!errors.length ||
		errors.some((error) => error.kind !== kind)
	)
		throw new Error("Incoherent incomplete-aggregate retry authority");
	const attempt = repo.attempts?.[kind] ?? 0;
	if (
		!Number.isSafeInteger(attempt) ||
		attempt < 1 ||
		attempt > maximum[kind] ||
		(kind === "structural" && !repo.validatedSource) ||
		(kind === "provider" && !repo.fallbackAttempted)
	)
		throw new Error("Incomplete aggregate has no budgeted retry authority");
}
