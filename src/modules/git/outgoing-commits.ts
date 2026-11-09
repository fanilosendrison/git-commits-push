/**
 * src/modules/git/outgoing-commits.ts — One authority for the exact outgoing
 * commit set of a publication.
 *
 * Every publication path (tracked push-only and explicit-target push-only)
 * depends on the same invariant: the commits that would be published must be
 * recomputable from the frozen baseline, must equal the durable snapshot
 * exactly, and must be scannable as patches before any push happens.
 */
import { PushError } from "../core/errors.ts";
import { CREATION_DIFF_ARGUMENTS } from "./creation-diff.ts";
import {
	assertCreationAncestry,
	assertCreationPatchObjectsLocal,
	readCreationLocalRevisions,
} from "./creation-local-objects.ts";
import {
	type GitExecutionPolicy,
	gitExecActualGraphArgs,
	gitExecArgs,
	gitExecutionProcessConfiguration,
} from "./git-exec.ts";
import { isFullGitObjectId } from "./git-object-id.ts";

/** The durable subset every publication snapshot exposes to the outgoing proof. */
export type OutgoingCommitSnapshot = {
	readonly validatedHeadSha: string;
	readonly outgoingShas: readonly string[];
} & (
	| { readonly destinationBaselineSha: string }
	| { readonly kind: "explicit-create"; readonly baseSha: string }
);

/** History boundary is separate from the absent destination expectation. */
export function outgoingHistoryBaseline(
	snapshot: OutgoingCommitSnapshot,
): string {
	return "baseSha" in snapshot
		? snapshot.baseSha
		: snapshot.destinationBaselineSha;
}

export function isAncestor(
	repoPath: string,
	possibleAncestor: string,
	possibleDescendant: string,
): boolean {
	try {
		gitExecArgs(
			["merge-base", "--is-ancestor", possibleAncestor, possibleDescendant],
			repoPath,
		);
		return true;
	} catch {
		return false;
	}
}

/** Ordered oldest-first list of commits reachable from HEAD but not the baseline. */
export function readOrderedOutgoingShas(
	repoPath: string,
	baselineSha: string,
	headSha: string,
	localOnly = false,
	executionPolicy: GitExecutionPolicy = "inherit",
): string[] {
	const args = ["--reverse", `${baselineSha}..${headSha}`];
	const result = localOnly
		? readCreationLocalRevisions(repoPath, args, executionPolicy)
		: gitExecArgs(
				["rev-list", ...args],
				repoPath,
				gitExecutionProcessConfiguration(executionPolicy),
			);
	const shas = result
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (localOnly && shas.some((sha) => !isFullGitObjectId(sha)))
		throw new PushError(
			"Creation prerequisite missing: outgoing commit objects are not all local (no automatic fetch).",
			false,
		);
	return shas;
}

/**
 * Prove that a durable snapshot still describes the exact outgoing work:
 * the frozen baseline must be an ancestor of the validated HEAD, and the
 * recomputed ordered commit set must match the snapshot element for element.
 * `label` names the publication path in the diagnostic so each caller keeps its
 * own stable wording while the invariant has one implementation.
 */
export function assertOutgoingCommitsMatch(
	repoPath: string,
	snapshot: OutgoingCommitSnapshot,
	label: string,
): void {
	const localOnly = "baseSha" in snapshot;
	if (localOnly)
		assertCreationAncestry(
			repoPath,
			snapshot.baseSha,
			snapshot.validatedHeadSha,
		);
	else if (
		!isAncestor(
			repoPath,
			outgoingHistoryBaseline(snapshot),
			snapshot.validatedHeadSha,
		)
	) {
		throw new PushError(
			`${label} baseline is not an ancestor of the validated HEAD.`,
			false,
		);
	}
	const currentOutgoingShas = readOrderedOutgoingShas(
		repoPath,
		outgoingHistoryBaseline(snapshot),
		snapshot.validatedHeadSha,
		localOnly,
	);
	if (
		currentOutgoingShas.length !== snapshot.outgoingShas.length ||
		currentOutgoingShas.some(
			(sha, index) => sha !== snapshot.outgoingShas[index],
		)
	) {
		throw new PushError(
			`${label} outgoing commit list no longer matches the validated snapshot.`,
			false,
		);
	}
}

/** Concatenated patches for every outgoing commit, in publication order. */
export function readCommitPatches(
	repoPath: string,
	outgoingShas: readonly string[],
	localOnly = false,
	allMergeParents = false,
	executionPolicy: GitExecutionPolicy = "inherit",
): string {
	if (localOnly)
		assertCreationPatchObjectsLocal(repoPath, outgoingShas, executionPolicy);
	const readPatch = (args: readonly string[]): string =>
		localOnly
			? gitExecActualGraphArgs(args, repoPath, executionPolicy)
			: gitExecArgs(
					args,
					repoPath,
					gitExecutionProcessConfiguration(executionPolicy),
				);
	return outgoingShas
		.map((sha) =>
			readPatch(
				localOnly
					? [
							"show",
							...(allMergeParents ? ["-m"] : []),
							"--format=",
							"--root",
							"--patch",
							...CREATION_DIFF_ARGUMENTS,
							sha,
						]
					: ["show", "--format=", "--binary", "--no-ext-diff", sha],
			),
		)
		.join("\n");
}
