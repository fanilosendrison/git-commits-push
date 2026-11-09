import { CREATION_DIFF_ARGUMENTS } from "./creation-diff.ts";
import {
	type GitExecutionPolicy,
	gitExecArgsRaw,
	gitExecutionProcessConfiguration,
} from "./git-exec.ts";
import { readLocalObjectRevisions } from "./local-object-revisions.ts";
import {
	type IndexSourceSnapshot,
	PublicationCompletenessError,
	readEmptyTree,
} from "./validated-source.ts";

/** Scan and plan the pinned Git input, not whichever index exists during a later read.
 * Retain historical diff presentation outside creation; this is not the Issue 20 repair.
 */
export function readValidationInputDiff(
	repository: string,
	input: Pick<IndexSourceSnapshot, "baseHeadSha" | "expectedTreeSha">,
	creation: boolean,
	executionPolicy: GitExecutionPolicy = "inherit",
): string {
	try {
		if (
			readLocalObjectRevisions(
				repository,
				[
					"--quiet",
					"--objects",
					"--no-walk",
					input.expectedTreeSha,
					...(input.baseHeadSha ? [input.baseHeadSha] : []),
				],
				executionPolicy,
			) !== ""
		)
			throw new Error("Missing local validation input.");
	} catch {
		throw new PublicationCompletenessError(
			"Validation input objects are unavailable locally; refusing automatic retrieval.",
		);
	}
	return gitExecArgsRaw(
		[
			"--no-replace-objects",
			"diff",
			"--patch",
			...(creation ? CREATION_DIFF_ARGUMENTS : []),
			input.baseHeadSha ?? readEmptyTree(repository),
			input.expectedTreeSha,
			"--",
		],
		repository,
		gitExecutionProcessConfiguration(executionPolicy),
	);
}

/** Validation cannot ratify a different source observed after the scan. */
export function assertSameValidationInput(
	before: IndexSourceSnapshot,
	after: IndexSourceSnapshot,
): void {
	if (
		before.repository !== after.repository ||
		before.gitDirectory !== after.gitDirectory ||
		before.baseHeadSha !== after.baseHeadSha ||
		before.expectedTreeSha !== after.expectedTreeSha ||
		before.expectedChangedPaths.length !== after.expectedChangedPaths.length ||
		before.expectedChangedPaths.some(
			(file, i) => after.expectedChangedPaths[i] !== file,
		)
	)
		throw new PublicationCompletenessError(
			"Repository, HEAD or index changed during validation; refusing a new source authority.",
		);
}
