import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import { witnessPublicationIntentIssue } from "../../config/validated-source-state-schema.ts";
import type {
	CommitCompletionEvidence,
	CommitPlan,
	CommittedSha,
	ExplicitPublicationTargetSnapshot,
	OriginalHead,
	Settings,
	ValidatedSourceWitness,
} from "../../types.ts";
import {
	CommitPlanError,
	DiffHashMismatchError,
	GitExecError,
	PartialCommitError,
	PostCommitPushError,
	PushError,
} from "../core/errors.ts";
import { formatConventionalCommit } from "../formatters/commit-formatter.ts";
import { assertCommitPlanCoverage } from "./commit-plan-coverage.ts";
import { inspectCommitPlanFileState } from "./commit-plan-file-state.ts";
import { commitPlanMessage } from "./commit-plan-message.ts";
import type { ExplicitCreatePushSnapshot } from "./creation-types.ts";
import { publishExplicitCreateSnapshot } from "./explicit-create-push.ts";
import { assertExplicitCreateTargetCurrent } from "./explicit-create-target.ts";
import { publishExplicitTargetSnapshot } from "./explicit-push.ts";
import { assertExplicitPushTargetCurrent } from "./explicit-push-target.ts";
import { gitExecArgs } from "./git-exec.ts";
import { assertNoPreparedMerge } from "./prepared-merge-source.ts";
import { executePush, type PushExecutionResult } from "./push.ts";
import {
	assertFinalTree,
	assertValidatedSource,
	changedPaths,
	PublicationCompletenessError,
	readEmptyTree,
	readOriginalHead,
} from "./validated-source.ts";
import { readValidationInputDiff } from "./validation-source-input.ts";

function collectPendingFiles(
	plans: readonly CommitPlan[],
	index: number,
): string[] {
	const seen = new Set<string>();
	return plans
		.slice(index)
		.flatMap((plan) => plan.files)
		.filter((file) => {
			if (seen.has(file)) return false;
			seen.add(file);
			return true;
		});
}

/**
 * Execute multiple commits (one per CommitPlan) then publish once.
 *
 * Without a frozen explicit target this runs the existing global/tracked
 * publication path, where `autoPush` still decides whether a push happens. With
 * a frozen explicit target it proves the destination is still at the frozen
 * baseline before the first commit, then publishes the exact resulting HEAD to
 * that destination; `autoPush` is not consulted.
 *
 * @throws CommitPlanError — structural plan errors (empty, duplicate, missing, nonexistent)
 * @throws DiffHashMismatchError — staged diff changed during inference
 * @throws PartialCommitError — mid-loop failure after partial commits landed
 * @throws PostCommitPushError — push failure after all commits landed locally
 */
export async function executeMultiCommitAndPush(
	repoPath: string,
	plans: CommitPlan[],
	expectedDiffHash: string,
	settings: Settings,
	explicitPushTargetSnapshot?: ExplicitPublicationTargetSnapshot,
	completeness?: {
		readonly witness: ValidatedSourceWitness;
		readonly publisherIndexTreeSha?: string | undefined;
		readonly committedShas?: readonly CommittedSha[] | undefined;
	},
): Promise<{
	creationPublicationSnapshot?: ExplicitCreatePushSnapshot;
	commitCompletion: CommitCompletionEvidence;
	committedShas: CommittedSha[];
	originalHead: OriginalHead;
	pushRetryCount: number;
	publishedSha: string | null;
	remoteTrackingRefSynchronization: PushExecutionResult["remoteTrackingRefSynchronization"];
}> {
	assertNoPreparedMerge(repoPath);
	if (completeness?.witness.preparedMerge)
		throw new Error("Prepared merge requires its dedicated publisher.");
	const priorCommits = completeness?.committedShas ?? [];
	const { witness, remainingPaths } = assertValidatedSource(
		repoPath,
		completeness?.witness,
		priorCommits,
		completeness?.publisherIndexTreeSha,
	);
	const intentIssue = witnessPublicationIntentIssue(
		witness,
		explicitPushTargetSnapshot,
	);
	if (intentIssue) throw new PublicationCompletenessError(intentIssue);
	assertCommitPlanCoverage(
		repoPath,
		plans,
		remainingPaths,
		witness.expectedChangedPaths,
	);

	// 3. Compare the same pinned representation used during validation.
	// Historical empty hashes never waive witness/HEAD/index/worktree checks.
	const EMPTY_DIFF_HASH =
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
	if (priorCommits.length === 0 && expectedDiffHash !== EMPTY_DIFF_HASH) {
		const currentDiff = readValidationInputDiff(
			repoPath,
			witness,
			!!explicitPushTargetSnapshot && "kind" in explicitPushTargetSnapshot,
		);
		const currentHash = crypto
			.createHash("sha256")
			.update(currentDiff)
			.digest("hex");
		if (currentHash !== expectedDiffHash) {
			throw new DiffHashMismatchError();
		}
	}

	// 4. Proving the frozen explicit destination is untouched must happen before
	//    the first history effect, so a remote that advanced during validation can
	//    never receive a commit built on a stale baseline.
	if (explicitPushTargetSnapshot) {
		if ("kind" in explicitPushTargetSnapshot)
			assertExplicitCreateTargetCurrent(repoPath, explicitPushTargetSnapshot);
		else assertExplicitPushTargetCurrent(repoPath, explicitPushTargetSnapshot);
	}

	// 5. Capture original HEAD, preserving a proven unborn branch as null.
	const originalHead = witness.baseHeadSha;
	assertValidatedSource(
		repoPath,
		witness,
		priorCommits,
		completeness?.publisherIndexTreeSha,
	);

	// 6. Unstage everything so we can re-stage file-by-file. The default mixed
	//    reset works against both an existing HEAD and Git's empty unborn index.
	assertNoPreparedMerge(repoPath);
	gitExecArgs(["reset", "--mixed"], repoPath);
	const resetHead = priorCommits.at(-1)?.sha ?? originalHead;
	let publisherIndexTreeSha =
		resetHead === null
			? readEmptyTree(repoPath)
			: gitExecArgs(
					["--no-replace-objects", "rev-parse", `${resetHead}^{tree}`],
					repoPath,
				);

	// 7. Commits naturally leave index == HEAD; never reset raced input on failure.
	const committedShas: CommittedSha[] = [];

	try {
		for (const [i, plan] of plans.entries()) {
			const pendingFiles = collectPendingFiles(plans, i);
			try {
				const beforeHead = readOriginalHead(repoPath);
				if (
					beforeHead !==
					(committedShas.at(-1)?.sha ??
						priorCommits.at(-1)?.sha ??
						originalHead)
				)
					throw new PublicationCompletenessError(
						"HEAD changed during commit execution.",
					);
				// Stage the plan's files, never a concurrently prepared merge.
				assertNoPreparedMerge(repoPath);
				gitExecArgs(
					["--literal-pathspecs", "add", "--", ...plan.files],
					repoPath,
				);

				const stagedTree = gitExecArgs(["write-tree"], repoPath);
				const stagedPaths = changedPaths(repoPath, beforeHead, stagedTree);
				const wrongContent = new Set(
					changedPaths(repoPath, stagedTree, witness.expectedTreeSha),
				);
				if (
					stagedPaths.some(
						(file) => !plan.files.includes(file) || wrongContent.has(file),
					) ||
					plan.files.some(
						(file) =>
							remainingPaths.includes(file) && !stagedPaths.includes(file),
					)
				)
					throw new PublicationCompletenessError(
						"Staged plan no longer matches validated source content.",
					);

				publisherIndexTreeSha = stagedTree;

				commitPlanMessage(repoPath, formatConventionalCommit(plan.commit));

				// Capture the SHA
				const sha = execSync("git rev-parse HEAD", {
					cwd: repoPath,
					encoding: "utf-8",
				}).trim();
				committedShas.push({ sha, files: [...plan.files] });
			} catch (commitErr) {
				const fileState = inspectCommitPlanFileState(repoPath, plan.files);
				if (fileState.nonexistentFiles.length > 0) {
					throw new CommitPlanError(
						`Plan ${i + 1}/${plans.length} references file(s) that do not exist on disk or in Git: ${fileState.nonexistentFiles.join(", ")}.`,
						"nonexistent-file",
						[...fileState.nonexistentFiles],
						{
							publisherIndexTreeSha,
							committedShas: [...committedShas],
							pendingFiles,
						},
					);
				}
				if (fileState.unchangedFiles.length === plan.files.length) {
					throw new CommitPlanError(
						`Plan ${i + 1}/${plans.length} has no changes for file(s): ${fileState.unchangedFiles.join(", ")}.`,
						"missing-file",
						[...fileState.unchangedFiles],
						{
							publisherIndexTreeSha,
							committedShas: [...committedShas],
							pendingFiles,
						},
					);
				}

				// Structural file-state failures are classified without localized stderr.
				const commitErrMsg =
					commitErr instanceof Error ? commitErr.message : String(commitErr);
				const commitErrStdout =
					commitErr && typeof commitErr === "object" && "stdout" in commitErr
						? String((commitErr as { stdout: unknown }).stdout)
						: "";
				const commitErrStderr =
					commitErr && typeof commitErr === "object" && "stderr" in commitErr
						? String((commitErr as { stderr: unknown }).stderr)
						: "";
				const msg = `${commitErrMsg}\n${commitErrStdout}\n${commitErrStderr}`;

				throw new PartialCommitError(
					`Commit ${i + 1}/${plans.length} failed: ${msg}. ` +
						`${committedShas.length} commit(s) already in history (from ${originalHead ? originalHead.slice(0, 7) : "unborn HEAD"}). ` +
						`${pendingFiles.length} file(s) still pending.`,
					{
						committedShas,
						publisherIndexTreeSha,
						originalHead,
						failedIndex: i,
						totalCount: plans.length,
						pendingFiles,
					},
				);
			}
		}
	} catch (err) {
		if (err instanceof CommitPlanError || err instanceof PartialCommitError) {
			throw err;
		}
		throw new GitExecError(
			err instanceof Error ? err.message : String(err),
			"unknown",
			-1,
		);
	}

	let finalTreeSha: string;
	try {
		assertValidatedSource(
			repoPath,
			witness,
			[...priorCommits, ...committedShas],
			publisherIndexTreeSha,
		);
		finalTreeSha = assertFinalTree(repoPath, witness);
	} catch (error) {
		throw new PartialCommitError(
			`Final completeness not demonstrated: ${error instanceof Error ? error.message : String(error)}`,
			{
				committedShas,
				publisherIndexTreeSha,
				originalHead,
				failedIndex: plans.length,
				totalCount: plans.length,
				pendingFiles: changedPaths(
					repoPath,
					readOriginalHead(repoPath),
					witness.expectedTreeSha,
				),
			},
		);
	}

	const finalHeadSha = committedShas.at(-1)?.sha;
	if (!finalHeadSha)
		throw new PublicationCompletenessError(
			"No established final commit identity.",
		);

	// 8. Publish the proven commit, never a newly re-resolved HEAD.
	let creationPublicationSnapshot: ExplicitCreatePushSnapshot | undefined;
	let pushRetryCount: number;
	let publishedSha: string | null;
	let remoteTrackingRefSynchronization: PushExecutionResult["remoteTrackingRefSynchronization"];
	try {
		if (explicitPushTargetSnapshot) {
			let publication: {
				readonly retryCount: number;
				readonly publishedSha: string;
			};
			if ("kind" in explicitPushTargetSnapshot) {
				const creation = await publishExplicitCreateSnapshot(
					repoPath,
					explicitPushTargetSnapshot,
					settings,
					finalHeadSha,
				);
				creationPublicationSnapshot = creation.snapshot;
				publication = creation;
			} else {
				publication = publishExplicitTargetSnapshot(
					repoPath,
					explicitPushTargetSnapshot,
					finalHeadSha,
				);
			}
			pushRetryCount = publication.retryCount;
			publishedSha = publication.publishedSha;
			// Explicit publication owns no local remote-tracking projection.
			remoteTrackingRefSynchronization = "not-applicable";
		} else {
			({
				retryCount: pushRetryCount,
				publishedSha,
				remoteTrackingRefSynchronization,
			} = executePush(repoPath, witness.publicationRequired, finalHeadSha));
		}
		if (witness.publicationRequired && publishedSha !== finalHeadSha)
			throw new PushError(
				"Required exact publication was not verified; local commits are preserved.",
				false,
				pushRetryCount,
			);
	} catch (error) {
		if (error instanceof PushError) {
			throw new PostCommitPushError(error, {
				committedShas: [...committedShas],
				originalHead,
				pushRetryCount: error.retryCount,
			});
		}
		throw error;
	}

	return {
		commitCompletion: { finalHeadSha, finalTreeSha },
		...(creationPublicationSnapshot ? { creationPublicationSnapshot } : {}),
		committedShas,
		originalHead,
		pushRetryCount,
		publishedSha,
		remoteTrackingRefSynchronization,
	};
}
