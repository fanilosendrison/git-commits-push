import type { RepoState } from "../../types.ts";
import { readCreationStagedDiff } from "./creation-diff.ts";
import { gitExecArgsRaw } from "./git-exec.ts";
import {
	assertValidatedSource,
	PublicationCompletenessError,
} from "./validated-source.ts";

/** Retry only the original authority, using actual remaining Git content, without staging. */
export function readValidatedRetryDiff(repo: RepoState): string | undefined {
	if (!repo.validatedSource) return undefined;
	const source = assertValidatedSource(
		repo.repository,
		repo.validatedSource,
		repo.committedShas,
	);
	let diff: string;
	if (!repo.committedShas?.length) {
		diff =
			repo.explicitPushTargetSnapshot &&
			"kind" in repo.explicitPushTargetSnapshot
				? readCreationStagedDiff(repo.repository)
				: gitExecArgsRaw(["diff", "--cached"], repo.repository);
	} else {
		if (!source.head)
			throw new PublicationCompletenessError(
				"Partial commits have no established HEAD.",
			);
		diff = gitExecArgsRaw(
			[
				"--no-replace-objects",
				"diff",
				"--no-ext-diff",
				"--no-textconv",
				"--no-renames",
				source.head,
				source.witness.expectedTreeSha,
				"--",
			],
			repo.repository,
		);
	}
	if (!diff.trim())
		throw new PublicationCompletenessError(
			"No remaining validated diff authorizes inference; completion and required publication need independent evidence.",
		);
	return diff;
}
