import { preparedMergeMessageSchema } from "../../config/prepared-merge-state-schema.ts";
import type {
	ExplicitPushTargetSnapshot,
	RepositoryInfo,
	Settings,
	ValidatedSourceWitness,
} from "../../types.ts";
import {
	runTestCascade,
	type SecretScanner,
	validateDiffForSecrets,
} from "../core/validators/pre-commit-validators.ts";
import {
	assertCreationAncestry,
	assertCreationDirtyInputsLocal,
	assertLocalCommitObject,
} from "./creation-local-objects.ts";
import { captureExplicitPushTargetSnapshot } from "./explicit-push-target.ts";
import { gitExecArgs, gitExecutionProcessConfiguration } from "./git-exec.ts";
import {
	readCommitPatches,
	readOrderedOutgoingShas,
} from "./outgoing-commits.ts";
import {
	preparedCommitIdentity,
	readPreparedHeadReference,
} from "./prepared-merge-identity.ts";
import {
	assertPreparedMergeCommit,
	readPreparedIndexDigest,
	readPreparedMergeHead,
} from "./prepared-merge-source.ts";
import type { PreparedMergeScope } from "./prepared-merge-types.ts";
import {
	assertValidatedSource,
	readIndexSource,
	readOriginalHead,
} from "./validated-source.ts";
import { readValidationInputDiff } from "./validation-source-input.ts";

/** Refuse ambient alternate repository/index selection rather than qualify another source. */
function assertExactGitEnvironment(): void {
	for (const key of [
		"GIT_INDEX_FILE",
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	])
		if (process.env[key] !== undefined)
			throw new Error(`Prepared merge refuses ambient ${key}.`);
}

/** Revalidate all frozen source facts, including exact full-index membership. */
export function assertPreparedMergeInput(
	scope: PreparedMergeScope,
	witness: ValidatedSourceWitness,
	committedSha?: string,
): void {
	assertExactGitEnvironment();
	const merge = witness.preparedMerge;
	if (
		!merge ||
		witness.repository !== scope.repository ||
		witness.baseHeadSha !== scope.firstParent ||
		witness.expectedTreeSha !== scope.indexTree ||
		merge.secondParentSha !== scope.secondParent ||
		merge.message !== scope.mergeMessage ||
		!witness.publicationRequired ||
		scope.firstParent === scope.secondParent
	)
		throw new Error(
			"Prepared merge source does not bind the exact caller authority.",
		);
	if (
		readPreparedHeadReference(scope.repository) !== merge.headReference ||
		preparedCommitIdentity(scope, merge.authorIdent, merge.committerIdent) !==
			merge.expectedCommitSha
	)
		throw new Error(
			"Prepared merge HEAD reference or deterministic commit identity changed.",
		);
	preparedMergeMessageSchema.parse(scope.mergeMessage);
	assertLocalCommitObject(
		scope.repository,
		scope.firstParent,
		"prepared-merge",
	);
	assertLocalCommitObject(
		scope.repository,
		scope.secondParent,
		"prepared-merge",
	);
	if (
		!committedSha &&
		readPreparedMergeHead(scope.repository) !== scope.secondParent
	)
		throw new Error("MERGE_HEAD changed from the expected second parent.");
	if (readPreparedIndexDigest(scope.repository) !== merge.indexEntriesDigest)
		throw new Error(
			"Prepared merge complete index membership changed after validation.",
		);
	if (committedSha)
		assertPreparedMergeCommit(scope.repository, committedSha, witness);
	assertValidatedSource(
		scope.repository,
		witness,
		committedSha
			? [{ sha: committedSha, files: [...witness.expectedChangedPaths] }]
			: [],
	);
	if (
		readOriginalHead(scope.repository, "prepared-merge") !==
			(committedSha ?? scope.firstParent) ||
		readPreparedIndexDigest(scope.repository) !== merge.indexEntriesDigest ||
		(!committedSha &&
			readPreparedMergeHead(scope.repository) !== scope.secondParent)
	)
		throw new Error("Prepared source changed during qualification.");
}

/** Capture once without staging, then validate pinned actual content and complete outgoing history. */
export async function validatePreparedMerge(
	scope: PreparedMergeScope,
	settings: Settings,
	scanner?: SecretScanner,
): Promise<{
	witness: ValidatedSourceWitness;
	target: ExplicitPushTargetSnapshot;
}> {
	assertExactGitEnvironment();
	const target = captureExplicitPushTargetSnapshot(scope.repository, {
		remote: scope.pushRemote,
		destinationRef: scope.pushRef,
	});
	assertCreationDirtyInputsLocal(scope.repository, "prepared-merge");
	const authorIdent = gitExecArgs(
		["var", "GIT_AUTHOR_IDENT"],
		scope.repository,
		gitExecutionProcessConfiguration("prepared-merge"),
	);
	const committerIdent = gitExecArgs(
		["var", "GIT_COMMITTER_IDENT"],
		scope.repository,
		gitExecutionProcessConfiguration("prepared-merge"),
	);
	const witness: ValidatedSourceWitness = {
		...readIndexSource(scope.repository, "prepared-merge"),
		publicationRequired: true,
		preparedMerge: {
			authorIdent,
			committerIdent,
			expectedCommitSha: preparedCommitIdentity(
				scope,
				authorIdent,
				committerIdent,
			),
			headReference: readPreparedHeadReference(scope.repository),
			secondParentSha: scope.secondParent,
			message: scope.mergeMessage,
			indexEntriesDigest: readPreparedIndexDigest(scope.repository),
		},
	};
	assertPreparedMergeInput(scope, witness);
	assertCreationAncestry(
		scope.repository,
		target.destinationBaselineSha,
		scope.firstParent,
		"prepared-merge",
	);
	if (!settings.skipTests) await runTestCascade(scope.repository);
	const repo: RepositoryInfo = { id: "prepared-merge", path: scope.repository };
	const outgoing = [
		...new Set(
			[scope.firstParent, scope.secondParent].flatMap((sha) =>
				readOrderedOutgoingShas(
					scope.repository,
					target.destinationBaselineSha,
					sha,
					true,
					"prepared-merge",
				),
			),
		),
	];
	await validateDiffForSecrets(
		repo,
		readCommitPatches(scope.repository, outgoing, true, true, "prepared-merge"),
		scanner,
	);
	await validateDiffForSecrets(
		repo,
		readValidationInputDiff(scope.repository, witness, true, "prepared-merge"),
		scanner,
	);
	assertPreparedMergeInput(scope, witness);
	return { witness, target };
}
