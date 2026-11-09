import { witnessPublicationIntentIssue } from "../../config/validated-source-state-schema.ts";
import type { CommitCompletionEvidence, RepoState } from "../../types.ts";
import { readPreparedHeadReference } from "./prepared-merge-identity.ts";
import {
	assertNoPreparedMerge,
	readPreparedIndexDigest,
} from "./prepared-merge-source.ts";
import {
	assertFinalTree,
	assertValidatedSource,
	PublicationCompletenessError,
	readOriginalHead,
} from "./validated-source.ts";

function assertPreparedTerminalState(repo: RepoState): void {
	const merge = repo.validatedSource?.preparedMerge;
	if (!merge) return;
	assertNoPreparedMerge(repo.repository);
	if (
		readPreparedIndexDigest(repo.repository) !== merge.indexEntriesDigest ||
		readPreparedHeadReference(repo.repository) !== merge.headReference
	)
		throw new PublicationCompletenessError(
			"Prepared merge state no longer matches terminal membership or HEAD reference.",
		);
}

/** The sole terminal proof: complete actual membership, original T, and required publication. */
function proveCommitCompletion(
	repo: RepoState,
	source: ReturnType<typeof assertValidatedSource>,
): CommitCompletionEvidence {
	const intentIssue = witnessPublicationIntentIssue(
		source.witness,
		repo.explicitPushTargetSnapshot,
	);
	if (intentIssue) throw new PublicationCompletenessError(intentIssue);
	const finalHeadSha = source.head;
	if (!finalHeadSha || source.remainingPaths.length)
		throw new PublicationCompletenessError(
			"Complete commit result has no exact validated-tree proof.",
		);
	const finalTreeSha = assertFinalTree(repo.repository, source.witness);
	if (readOriginalHead(repo.repository) !== finalHeadSha)
		throw new PublicationCompletenessError(
			"HEAD changed during terminal completeness verification.",
		);
	if (source.witness.publicationRequired && repo.publishedSha !== finalHeadSha)
		throw new PublicationCompletenessError(
			"Complete local commits lack durable required publication evidence; preserving history without replanning or republishing.",
		);
	return { finalHeadSha, finalTreeSha };
}

/** Terminal success needs a persisted proof matching Git, never a commit count. */
export function assertCommitCompletion(repo: RepoState): void {
	if (repo.operation === "push-only") return;
	assertPreparedTerminalState(repo);
	const source = assertValidatedSource(
		repo.repository,
		repo.validatedSource,
		repo.committedShas,
		repo.publisherIndexTreeSha,
	);
	const actual = proveCommitCompletion(repo, source);
	const proof = repo.commitCompletion;
	if (
		!proof ||
		proof.finalHeadSha !== actual.finalHeadSha ||
		proof.finalTreeSha !== actual.finalTreeSha
	)
		throw new PublicationCompletenessError(
			"Complete commit result has no exact validated-tree proof.",
		);
	assertPreparedTerminalState(repo);
}

/** Recover only an already complete checkpointed chain with its required publication.
 * Empty/failed model output is irrelevant to this independent Git proof. No effect
 * or inference is authorized when all validated paths have already landed.
 */
export function recoverCompletedCommit(repo: RepoState): RepoState | undefined {
	const source = assertValidatedSource(
		repo.repository,
		repo.validatedSource,
		repo.committedShas,
		repo.publisherIndexTreeSha,
	);
	if (source.remainingPaths.length) return undefined;
	if (
		!repo.committedShas?.length ||
		!source.witness.expectedChangedPaths.length
	)
		throw new PublicationCompletenessError(
			"No established complete commit result authorizes continuation.",
		);
	return {
		...repo,
		status: "SUCCESS",
		publisherIndexTreeSha: undefined,
		commitCompletion: proveCommitCompletion(repo, source),
	};
}

/** Preserve all effect evidence when terminal qualification fails. */
export function qualifyCommitOutcomes(
	repos: Record<string, RepoState>,
): Record<string, RepoState> {
	return Object.fromEntries(
		Object.entries(repos).map(([id, repo]) => {
			if (repo.status === "SUCCESS") {
				try {
					assertCommitCompletion(repo);
				} catch (error) {
					return [
						id,
						{
							...repo,
							status: "FAILED" as const,
							error: error instanceof Error ? error.message : String(error),
						},
					];
				}
			}
			if (repo.status === "RUNNING" || repo.status === "PENDING")
				return [
					id,
					{
						...repo,
						status: "FAILED" as const,
						error:
							"No terminal completeness evidence; pending results are not success.",
					},
				];
			return [id, repo];
		}),
	);
}
