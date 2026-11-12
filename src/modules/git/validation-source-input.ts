import { CREATION_DIFF_ARGUMENTS } from "./creation-diff.ts";
import {
	type GitExecutionPolicy,
	gitExecArgsRaw,
	gitExecBytesArgs,
	gitExecutionProcessConfiguration,
} from "./git-exec.ts";
import { readLocalObjectRevisions } from "./local-object-revisions.ts";
import {
	PublicationCompletenessError,
	readEmptyTree,
} from "./validated-source.ts";

interface ValidationDiffInput {
	readonly baseHeadSha: string | null;
	readonly expectedTreeSha: string;
}

/** One local-object proof and argument authority for text and byte-preserving reads. */
function validationDiffArguments(
	repository: string,
	input: ValidationDiffInput,
	creation: boolean,
	executionPolicy: GitExecutionPolicy,
): string[] {
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
	return [
		"--no-replace-objects",
		"diff",
		"--patch",
		...(creation ? CREATION_DIFF_ARGUMENTS : []),
		input.baseHeadSha ?? readEmptyTree(repository),
		input.expectedTreeSha,
		"--",
	];
}

/** Keep historical textual scan/hash semantics; this is not the Issue20 repair. */
export function readValidationInputDiff(
	repository: string,
	input: ValidationDiffInput,
	creation: boolean,
	executionPolicy: GitExecutionPolicy = "inherit",
): string {
	return gitExecArgsRaw(
		validationDiffArguments(repository, input, creation, executionPolicy),
		repository,
		gitExecutionProcessConfiguration(executionPolicy),
	);
}

/** New fullDiffHash binds unconverted complete stdout bytes, including invalid UTF-8. */
export function readValidationInputDiffBytes(
	repository: string,
	input: ValidationDiffInput,
	creation: boolean,
	executionPolicy: GitExecutionPolicy = "inherit",
): Buffer {
	return gitExecBytesArgs(
		validationDiffArguments(repository, input, creation, executionPolicy),
		repository,
		gitExecutionProcessConfiguration(executionPolicy),
	);
}

/** Validation cannot ratify a different source observed after the scan. */
export function assertSameValidationInput(
	before: {
		repository: string;
		gitDirectory: string;
		baseHeadSha: string | null;
		expectedTreeSha: string;
		expectedChangedPaths: readonly string[];
	},
	after: typeof before,
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
