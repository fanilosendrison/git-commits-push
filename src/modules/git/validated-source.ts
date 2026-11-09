import { realpathSync } from "node:fs";
import path from "node:path";
import type {
	CommittedSha,
	OriginalHead,
	ValidatedSourceWitness,
} from "../../types.ts";
import { PublicationCompletenessError } from "../core/errors.ts";
import {
	type GitExecutionPolicy,
	gitExecArgs,
	gitExecArgsRaw,
	gitExecutionProcessConfiguration,
} from "./git-exec.ts";
import {
	assertWorkingTree,
	readCurrentIndexTree,
} from "./validated-index-proof.ts";

export { PublicationCompletenessError } from "../core/errors.ts";

import { isFullGitObjectId } from "./git-object-id.ts";
import { readLocalObjectRevisions } from "./local-object-revisions.ts";
import { assertPreparedMergeCommit } from "./prepared-merge-source.ts";

export function readOriginalHead(
	repository: string,
	executionPolicy: GitExecutionPolicy = "inherit",
): OriginalHead {
	const config = gitExecutionProcessConfiguration(executionPolicy);
	try {
		const sha = gitExecArgs(
			["--no-replace-objects", "rev-parse", "--verify", "HEAD"],
			repository,
			config,
		);
		if (
			readLocalObjectRevisions(
				repository,
				["--no-walk", sha],
				executionPolicy,
			) !== sha
		)
			throw new PublicationCompletenessError(
				"HEAD is not a direct local commit identity.",
			);
		return sha;
	} catch (error) {
		const symbolic = gitExecArgs(
			["symbolic-ref", "--quiet", "HEAD"],
			repository,
			config,
		);
		if (
			!gitExecArgs(
				["for-each-ref", "--format=%(objectname)", "--", symbolic],
				repository,
				config,
			)
		)
			return null;
		throw error;
	}
}

/** Ask Git for its own object-format-specific empty tree identity. */
export function readEmptyTree(repository: string): string {
	return gitExecArgs(["hash-object", "-t", "tree", "--stdin"], repository);
}

export function readHeadTree(
	repository: string,
	executionPolicy: GitExecutionPolicy = "inherit",
): string {
	return gitExecArgs(
		["--no-replace-objects", "rev-parse", "HEAD^{tree}"],
		repository,
		gitExecutionProcessConfiguration(executionPolicy),
	);
}

/** Git paths are NUL-framed, literal, case-sensitive identities, not patch headers. */
export function changedPaths(
	repository: string,
	from: string | null,
	to: string,
	executionPolicy: GitExecutionPolicy = "inherit",
): string[] {
	const raw = gitExecArgsRaw(
		[
			"--no-replace-objects",
			"diff-tree",
			"--no-commit-id",
			"--name-only",
			"--no-renames",
			"-r",
			"-z",
			from ?? readEmptyTree(repository),
			to,
			"--",
		],
		repository,
		gitExecutionProcessConfiguration(executionPolicy),
	);
	if (raw && !raw.endsWith("\0"))
		throw new PublicationCompletenessError(
			"Malformed Git changed-path output.",
		);
	return raw ? raw.slice(0, -1).split("\0") : [];
}

function identity(
	repository: string,
	executionPolicy: GitExecutionPolicy = "inherit",
): {
	repository: string;
	gitDirectory: string;
} {
	return {
		repository: realpathSync(repository),
		gitDirectory: realpathSync(
			path.resolve(
				repository,
				gitExecArgs(
					["rev-parse", "--git-dir"],
					repository,
					gitExecutionProcessConfiguration(executionPolicy),
				),
			),
		),
	};
}

export type IndexSourceSnapshot = Omit<
	ValidatedSourceWitness,
	"publicationRequired"
>;

/** Pin the index input before scanning; this alone grants no commit authority. */
export function readIndexSource(
	repository: string,
	executionPolicy: GitExecutionPolicy = "inherit",
): IndexSourceSnapshot {
	const baseHeadSha = readOriginalHead(repository, executionPolicy);
	const expectedTreeSha = readCurrentIndexTree(repository, executionPolicy);
	return {
		...identity(repository, executionPolicy),
		baseHeadSha,
		expectedTreeSha,
		expectedChangedPaths: changedPaths(
			repository,
			baseHeadSha,
			expectedTreeSha,
			executionPolicy,
		),
	};
}

/** Capture only after staging and validation, before the first durable delegation. */
export function captureValidatedSource(
	repository: string,
	publicationRequired: boolean,
): ValidatedSourceWitness {
	return { ...readIndexSource(repository), publicationRequired };
}

function sourcePolicy(witness: ValidatedSourceWitness): GitExecutionPolicy {
	return witness.preparedMerge ? "prepared-merge" : "inherit";
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((p, i) => p === right[i]);
}

/** Re-establish source authority and actual landed membership without trusting plan metadata. */
export function assertValidatedSource(
	repository: string,
	witness: ValidatedSourceWitness | undefined,
	committed: readonly CommittedSha[] = [],
	publisherIndexTreeSha?: string,
): {
	witness: ValidatedSourceWitness;
	remainingPaths: string[];
	head: OriginalHead;
} {
	if (!witness)
		throw new PublicationCompletenessError(
			"Missing durable validated-source witness; historical state is diagnostic only.",
		);
	if (
		publisherIndexTreeSha !== undefined &&
		!isFullGitObjectId(publisherIndexTreeSha)
	)
		throw new PublicationCompletenessError(
			"Malformed publisher index progress identity.",
		);
	const currentIdentity = identity(repository, sourcePolicy(witness));
	if (
		witness.repository !== currentIdentity.repository ||
		witness.gitDirectory !== currentIdentity.gitDirectory
	)
		throw new PublicationCompletenessError(
			"Validated-source witness belongs to a different worktree.",
		);
	try {
		if (
			readLocalObjectRevisions(
				repository,
				[
					"--quiet",
					"--objects",
					"--no-walk",
					witness.expectedTreeSha,
					...(witness.baseHeadSha ? [witness.baseHeadSha] : []),
				],
				sourcePolicy(witness),
			) !== ""
		)
			throw new Error("Missing validated input objects.");
	} catch {
		throw new PublicationCompletenessError(
			"Validated source objects are unavailable locally; refusing automatic retrieval.",
		);
	}
	const expected = changedPaths(
		repository,
		witness.baseHeadSha,
		witness.expectedTreeSha,
		sourcePolicy(witness),
	);
	if (!samePaths(expected, witness.expectedChangedPaths))
		throw new PublicationCompletenessError(
			"Validated changed-path membership is incoherent.",
		);
	const expectedSet = new Set(expected);
	if (witness.preparedMerge && committed.length > 1)
		throw new PublicationCompletenessError(
			"Prepared merge cannot split the validated source across commits.",
		);
	let parent = witness.baseHeadSha;
	const accounted = new Set<string>();
	for (const commit of committed) {
		if (!isFullGitObjectId(commit.sha))
			throw new PublicationCompletenessError(
				"Malformed durable commit identity.",
			);
		if (witness.preparedMerge)
			assertPreparedMergeCommit(repository, commit.sha, witness);
		const parents = readLocalObjectRevisions(
			repository,
			["--parents", "--no-walk", commit.sha],
			sourcePolicy(witness),
		).split(" ");
		if (
			parents[0] !== commit.sha ||
			!samePaths(
				parents.slice(1),
				witness.preparedMerge
					? [parent ?? "", witness.preparedMerge.secondParentSha]
					: parent
						? [parent]
						: [],
			)
		)
			throw new PublicationCompletenessError(
				"Landed commit chain does not extend the validated HEAD exactly.",
			);
		const paths = changedPaths(
			repository,
			parent,
			commit.sha,
			sourcePolicy(witness),
		);
		const differing = new Set(
			changedPaths(
				repository,
				commit.sha,
				witness.expectedTreeSha,
				sourcePolicy(witness),
			),
		);
		const actualPaths = new Set(paths);
		if (
			commit.files.some(
				(file) => expectedSet.has(file) && !actualPaths.has(file),
			)
		)
			throw new PublicationCompletenessError(
				"Checkpointed ownership claims a validated path not changed by that commit.",
			);
		for (const file of paths) {
			if (
				!expectedSet.has(file) ||
				accounted.has(file) ||
				differing.has(file) ||
				!commit.files.includes(file)
			)
				throw new PublicationCompletenessError(
					"Landed commit contents do not match validated membership.",
				);
			accounted.add(file);
		}
		parent = commit.sha;
	}
	const head = readOriginalHead(repository, sourcePolicy(witness));
	if (head !== parent)
		throw new PublicationCompletenessError(
			`HEAD changed or contains uncheckpointed commits: observed ${head ?? "UNBORN"}, checkpointed ${parent ?? "UNBORN"}; preserving history without replanning.`,
		);
	const remainingPaths = expected.filter((file) => !accounted.has(file));
	const index = readCurrentIndexTree(repository, sourcePolicy(witness));
	if (index !== witness.expectedTreeSha) {
		const ownedIndex =
			publisherIndexTreeSha !== undefined && index === publisherIndexTreeSha;
		const staged =
			committed.length > 0 || ownedIndex
				? changedPaths(repository, head, index, sourcePolicy(witness))
				: undefined;
		const differing = new Set(
			changedPaths(
				repository,
				index,
				witness.expectedTreeSha,
				sourcePolicy(witness),
			),
		);
		if (
			!staged ||
			(publisherIndexTreeSha !== undefined && !ownedIndex) ||
			staged.some(
				(file) => !remainingPaths.includes(file) || differing.has(file),
			)
		)
			throw new PublicationCompletenessError(
				"Index changed after validation; refusing to adopt residual input.",
			);
	}
	assertWorkingTree(
		repository,
		witness.expectedTreeSha,
		witness.expectedChangedPaths,
		sourcePolicy(witness),
	);
	return {
		witness,
		remainingPaths,
		head,
	};
}

/** Remote identity alone is insufficient: prove the complete validated content first. */
export function assertFinalTree(
	repository: string,
	witness: ValidatedSourceWitness,
): string {
	const actual = readHeadTree(repository, sourcePolicy(witness));
	if (actual !== witness.expectedTreeSha)
		throw new PublicationCompletenessError(
			`Final tree completeness not demonstrated: expected ${witness.expectedTreeSha}, actual ${actual}.`,
		);
	assertWorkingTree(
		repository,
		witness.expectedTreeSha,
		witness.expectedChangedPaths,
		sourcePolicy(witness),
	);
	return actual;
}
