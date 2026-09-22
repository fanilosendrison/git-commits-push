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
import { gitExecArgs } from "./git-exec.ts";

/** The durable subset every publication snapshot exposes to the outgoing proof. */
export interface OutgoingCommitSnapshot {
	readonly destinationBaselineSha: string;
	readonly validatedHeadSha: string;
	readonly outgoingShas: readonly string[];
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
): string[] {
	return gitExecArgs(
		["rev-list", "--reverse", `${baselineSha}..${headSha}`],
		repoPath,
	)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
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
	if (
		!isAncestor(
			repoPath,
			snapshot.destinationBaselineSha,
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
		snapshot.destinationBaselineSha,
		snapshot.validatedHeadSha,
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
): string {
	return outgoingShas
		.map((sha) =>
			gitExecArgs(
				["show", "--format=", "--binary", "--no-ext-diff", sha],
				repoPath,
			),
		)
		.join("\n");
}
