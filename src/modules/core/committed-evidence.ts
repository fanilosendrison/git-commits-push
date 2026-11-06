import type { CommittedSha, OriginalHead, RepoState } from "../../types.ts";
import type { PostCommitPushError } from "./errors.ts";

/** Preserve exact landed commits, never duplicating prior retry evidence. */
export function mergeCommittedShas(
	existing: readonly CommittedSha[],
	incoming: readonly CommittedSha[],
): CommittedSha[] {
	const merged = [...existing];
	const known = new Set(existing.map(({ sha }) => sha));
	for (const commit of incoming) {
		if (known.has(commit.sha)) continue;
		known.add(commit.sha);
		merged.push(commit);
	}
	return merged;
}
export function preserveOriginalHead(
	existing: OriginalHead | undefined,
	incoming: OriginalHead,
): OriginalHead {
	return existing === undefined ? incoming : existing;
}
/** Retain commit and retry identity when publication fails after local commits. */
export function mergePostCommitPushFailure(
	repoState: RepoState,
	error: PostCommitPushError,
): RepoState {
	return {
		...repoState,
		committedShas: mergeCommittedShas(
			repoState.committedShas ?? [],
			error.context.committedShas,
		),
		originalHead: preserveOriginalHead(
			repoState.originalHead,
			error.context.originalHead,
		),
		attempts: {
			...(repoState.attempts ?? {}),
			network:
				(repoState.attempts?.network ?? 0) + error.context.pushRetryCount,
		},
	};
}
