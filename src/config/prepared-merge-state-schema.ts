import { z } from "zod";
import { validateCommitMessage } from "../modules/core/validators/commit-message-validator.ts";
import { parseCommitIdentity } from "../modules/git/prepared-merge-identity.ts";
import type { GlobalState, RepoState } from "../types.ts";
import {
	destinationRefSchema,
	gitObjectIdSchema,
} from "./publication-state-schema.ts";

/** Keep the exact subject canonical; the stored Git message adds precisely one LF. */
export const preparedMergeMessageSchema = z
	.string()
	.min(1)
	.refine(
		(message) =>
			message === message.trim() &&
			!/[\0\r\n]/u.test(message) &&
			validateCommitMessage(message).valid,
		"Prepared merge requires one canonical valid Conventional Commit subject.",
	);
export const preparedMergeSourceSchema = z
	.object({
		authorIdent: z.string().refine((value) => {
			try {
				parseCommitIdentity(value);
				return true;
			} catch {
				return false;
			}
		}),
		committerIdent: z.string().refine((value) => {
			try {
				parseCommitIdentity(value);
				return true;
			} catch {
				return false;
			}
		}),
		expectedCommitSha: gitObjectIdSchema,
		headReference: z.union([z.literal("HEAD"), destinationRefSchema]),
		secondParentSha: gitObjectIdSchema,
		message: preparedMergeMessageSchema,
		indexEntriesDigest: z.string().regex(/^[a-f0-9]{64}$/u),
	})
	.strict();

/** No historical scope or missing witness may manufacture prepared-merge authority. */
export function validatePreparedMergeRelations(
	scope: GlobalState["invocationScope"],
	repo: RepoState,
	issue: (message: string, field: string) => void,
): void {
	const merge = repo.validatedSource?.preparedMerge;
	if (scope.kind !== "prepared-merge") {
		if (merge)
			issue(
				"Prepared merge witness requires explicit prepared-merge scope.",
				"validatedSource",
			);
		return;
	}
	const witness = repo.validatedSource;
	if (
		!witness ||
		!merge ||
		witness.baseHeadSha !== scope.firstParent ||
		witness.expectedTreeSha !== scope.indexTree ||
		merge.secondParentSha !== scope.secondParent ||
		merge.message !== scope.mergeMessage ||
		!witness.publicationRequired
	)
		issue(
			"Prepared merge authority must bind both parents, tree, message and complete source.",
			"validatedSource",
		);
	if (
		repo.operation !== "commit-and-push" ||
		repo.pushSnapshot ||
		repo.publisherIndexTreeSha ||
		repo.creationPublicationSnapshot
	)
		issue(
			"Prepared merge cannot carry another operation's progress authority.",
			"operation",
		);
	if (
		!repo.explicitPushTargetSnapshot ||
		"kind" in repo.explicitPushTargetSnapshot
	)
		issue(
			"Prepared merge requires an existing frozen explicit target.",
			"explicitPushTargetSnapshot",
		);
	if ((repo.committedShas?.length ?? 0) > 1 || repo.commits !== undefined)
		issue(
			"Prepared merge permits exactly one commit, never a split plan.",
			"committedShas",
		);
	if (
		repo.commitCompletion &&
		(repo.committedShas?.length !== 1 ||
			repo.committedShas[0]?.sha !== repo.commitCompletion.finalHeadSha)
	)
		issue(
			"Prepared merge completion must retain exactly its established commit identity.",
			"commitCompletion",
		);
	if (
		repo.publishedSha !== undefined &&
		repo.publishedSha !== merge?.expectedCommitSha
	)
		issue(
			"Prepared publication evidence must retain exactly frozen M.",
			"publishedSha",
		);
	if (repo.committedShas && witness) {
		const files = repo.committedShas[0]?.files;
		if (
			files &&
			(files.length !== witness.expectedChangedPaths.length ||
				files.some((file, i) => file !== witness.expectedChangedPaths[i]))
		)
			issue(
				"Prepared merge ownership must equal complete canonical source membership.",
				"committedShas",
			);
	}
}
