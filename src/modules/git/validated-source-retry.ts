import type { RepoState } from "../../types.ts";
import {
	assertValidatedSource,
	PublicationCompletenessError,
} from "./validated-source.ts";
import { readValidationInputDiff } from "./validation-source-input.ts";

/** Retry only the original authority, with the same Git representation as validation. */
export function readValidatedRetryDiff(repo: RepoState): string | undefined {
	if (!repo.validatedSource) return undefined;
	const source = assertValidatedSource(
		repo.repository,
		repo.validatedSource,
		repo.committedShas,
	);
	if (repo.committedShas?.length && !source.head)
		throw new PublicationCompletenessError(
			"Partial commits have no established HEAD.",
		);
	const diff = readValidationInputDiff(
		repo.repository,
		{
			baseHeadSha: repo.committedShas?.length
				? source.head
				: source.witness.baseHeadSha,
			expectedTreeSha: source.witness.expectedTreeSha,
		},
		!!repo.explicitPushTargetSnapshot &&
			"kind" in repo.explicitPushTargetSnapshot,
	);
	if (!diff.trim())
		throw new PublicationCompletenessError(
			"No remaining validated diff authorizes inference; completion and required publication need independent evidence.",
		);
	return diff;
}
