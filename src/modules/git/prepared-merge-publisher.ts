import {
	lstatSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RepoState, ValidatedSourceWitness } from "../../types.ts";
import { publishExplicitTargetSnapshot } from "./explicit-push.ts";
import {
	assertExplicitPushTargetCurrent,
	openFrozenExplicitEndpoint,
} from "./explicit-push-target.ts";
import {
	gitCreatePreparedCommit,
	gitExecArgs,
	HOOK_DISABLED_PROCESS_CONFIGURATION,
} from "./git-exec.ts";
import { readLocalObjectRevisions } from "./local-object-revisions.ts";
import { parseCommitIdentity } from "./prepared-merge-identity.ts";
import {
	assertNoPreparedMerge,
	assertPreparedMergeCommit,
	readPreparedMergeHead,
} from "./prepared-merge-source.ts";
import type { PreparedMergeScope } from "./prepared-merge-types.ts";
import { assertPreparedMergeInput } from "./prepared-merge-validation.ts";
import { readOriginalHead } from "./validated-source.ts";

/** A recognized exact commit may outlive interrupted merge-state cleanup. */
function finishConsumedMergeState(scope: PreparedMergeScope): void {
	const file = path.resolve(
		scope.repository,
		gitExecArgs(["rev-parse", "--git-path", "MERGE_HEAD"], scope.repository),
	);
	try {
		lstatSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (readPreparedMergeHead(scope.repository) !== scope.secondParent)
		throw new Error("Foreign MERGE_HEAD after merge commit; preserving state.");
	unlinkSync(file);
}

function objectExists(repository: string, sha: string): boolean {
	try {
		return readLocalObjectRevisions(repository, ["--no-walk", sha]) === sha;
	} catch {
		return false;
	}
}

/** Freeze identities before this operation; an orphan object is the same deterministic M, never M2. */
function ensureExactCommitObject(
	scope: PreparedMergeScope,
	witness: ValidatedSourceWitness,
): string {
	const merge = witness.preparedMerge;
	if (!merge)
		throw new Error("Missing durable deterministic commit authority.");
	const sha = merge.expectedCommitSha;
	if (!objectExists(scope.repository, sha)) {
		const directory = mkdtempSync(
			path.join(tmpdir(), "gcp-prepared-merge-message-"),
		);
		const messageFile = path.join(directory, "message");
		try {
			writeFileSync(messageFile, `${merge.message}\n`, { mode: 0o600 });
			const actual = gitCreatePreparedCommit(
				scope.repository,
				scope.indexTree,
				[scope.firstParent, scope.secondParent],
				messageFile,
				{
					author: parseCommitIdentity(merge.authorIdent),
					committer: parseCommitIdentity(merge.committerIdent),
				},
			);
			if (actual !== sha)
				throw new Error(
					"Created commit differs from the checkpointed deterministic identity.",
				);
		} catch (error) {
			if (!objectExists(scope.repository, sha)) throw error;
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
	assertPreparedMergeCommit(scope.repository, sha, witness);
	return sha;
}

/** Create or recognize exactly the checkpointed M, then install it with an expected-old guard.
 * Neither MERGE_MODE, hooks, the planner nor current timestamp can change its parents or identity.
 */
export function establishPreparedMergeCommit(
	scope: PreparedMergeScope,
	repo: RepoState,
): RepoState {
	const witness = repo.validatedSource;
	if (!witness?.preparedMerge)
		throw new Error("Prepared merge has no durable validated source.");
	const target = repo.explicitPushTargetSnapshot;
	if (!target || "kind" in target)
		throw new Error("Missing frozen existing merge destination.");
	let head = readOriginalHead(scope.repository);
	if (!head)
		throw new Error("Prepared merge requires an existing first parent.");
	if ((repo.committedShas?.length ?? 0) > 1 || repo.commits !== undefined)
		throw new Error("Planner cannot supply or split a prepared merge.");
	const known = repo.committedShas?.[0]?.sha;
	if (known && known !== head)
		throw new Error("HEAD differs from the established merge SHA.");
	if (head === scope.firstParent) {
		if (known)
			throw new Error(
				"Established merge history disappeared; refusing recreation.",
			);
		assertPreparedMergeInput(scope, witness);
		assertExplicitPushTargetCurrent(scope.repository, target);
		assertPreparedMergeInput(scope, witness);
		const sha = ensureExactCommitObject(scope, witness);
		// Object creation cannot authorize installing a changed index, HEAD or MERGE_HEAD.
		assertPreparedMergeInput(scope, witness);
		try {
			gitExecArgs(
				[
					"update-ref",
					"--no-deref",
					witness.preparedMerge.headReference,
					sha,
					scope.firstParent,
				],
				scope.repository,
				HOOK_DISABLED_PROCESS_CONFIGURATION,
			);
		} catch (error) {
			if (readOriginalHead(scope.repository) !== sha) throw error;
		}
		head = readOriginalHead(scope.repository);
	}
	if (!head || head !== witness.preparedMerge.expectedCommitSha)
		throw new Error(
			"No uniquely established exact merge commit; preserving history.",
		);
	assertPreparedMergeInput(scope, witness, head);
	finishConsumedMergeState(scope);
	assertPreparedMergeInput(scope, witness, head);
	return {
		...repo,
		committedShas: [{ sha: head, files: [...witness.expectedChangedPaths] }],
		originalHead: scope.firstParent,
		commitCompletion: {
			finalHeadSha: head,
			finalTreeSha: witness.expectedTreeSha,
		},
	};
}

/** Publish only the established M, with source/endpoint requalification at every transport send. */
export function publishEstablishedPreparedMerge(
	scope: PreparedMergeScope,
	repo: RepoState,
): RepoState {
	const sha = assertEstablishedPreparedMerge(scope, repo);
	const target = repo.explicitPushTargetSnapshot;
	if (!target || "kind" in target)
		throw new Error("Missing exact existing target.");
	const publication = publishExplicitTargetSnapshot(
		repo.repository,
		target,
		sha,
		() => {
			openFrozenExplicitEndpoint(repo.repository, target, "disabled");
			assertEstablishedPreparedMerge(scope, repo);
		},
		"disabled",
	);
	return {
		...repo,
		status: "SUCCESS",
		publishedSha: publication.publishedSha,
		remoteTrackingRefSynchronization: "not-applicable",
	};
}

/** Read-only requalification of checkpointed M immediately before a publication send. */
export function assertEstablishedPreparedMerge(
	scope: PreparedMergeScope,
	repo: RepoState,
): string {
	const sha = repo.committedShas?.[0]?.sha;
	if (
		!sha ||
		repo.committedShas?.length !== 1 ||
		!repo.validatedSource ||
		repo.commitCompletion?.finalHeadSha !== sha ||
		repo.commitCompletion.finalTreeSha !== scope.indexTree
	)
		throw new Error(
			"Publication requires one checkpointed exact merge commit.",
		);
	assertPreparedMergeInput(scope, repo.validatedSource, sha);
	assertNoPreparedMerge(scope.repository);
	return sha;
}
