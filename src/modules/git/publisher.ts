import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	CommitPlan,
	CommittedSha,
	ExplicitPushTargetSnapshot,
	OriginalHead,
	Settings,
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
import { inspectCommitPlanFileState } from "./commit-plan-file-state.ts";
import { publishExplicitTargetSnapshot } from "./explicit-push.ts";
import { assertExplicitPushTargetCurrent } from "./explicit-push-target.ts";
import { gitExecArgs } from "./git-exec.ts";
import { executePush, type PushExecutionResult } from "./push.ts";

/**
 * Helper to normalize file paths for the duplicate file check.
 */
function normalizePath(p: string): string {
	return path.posix.normalize(p).replace(/\/+$/, "");
}

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

function readOriginalHead(repository: string): OriginalHead {
	try {
		return gitExecArgs(["rev-parse", "--verify", "HEAD"], repository);
	} catch (error) {
		const symbolicHead = gitExecArgs(
			["symbolic-ref", "--quiet", "HEAD"],
			repository,
		);
		const referencedHead = gitExecArgs(
			["for-each-ref", "--format=%(objectname)", "--", symbolicHead],
			repository,
		);
		if (!referencedHead) return null;
		throw error;
	}
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
	explicitPushTargetSnapshot?: ExplicitPushTargetSnapshot,
): Promise<{
	committedShas: CommittedSha[];
	originalHead: OriginalHead;
	pushRetryCount: number;
	publishedSha: string | null;
	remoteTrackingRefSynchronization: PushExecutionResult["remoteTrackingRefSynchronization"];
}> {
	// 1. Empty-plans guard
	if (plans.length === 0) {
		throw new CommitPlanError(
			"executeMultiCommitAndPush: received an empty plans array.",
			"empty-plans",
		);
	}

	// 2. Duplicate file guard with path normalization
	const seen = new Set<string>();
	for (const plan of plans) {
		for (const file of plan.files) {
			const normalized = normalizePath(file);
			if (seen.has(normalized)) {
				throw new CommitPlanError(
					`Invalid commit plan: file "${file}" appears in multiple plans. ` +
						`Files that contain multiple concerns must be grouped into a single Fat Commit plan.`,
					"duplicate-file",
					[file],
				);
			}
			seen.add(normalized);
		}
	}

	// 3. DiffHash race-condition guard
	// R73: skip guard when the stored hash is the empty-diff hash (e3b0c44...)
	// This happens when the index was cleared between step1 and step2 due to
	// a prior retry resetting the staging area. An empty expected hash means
	// there is no staged content to race against.
	const EMPTY_DIFF_HASH =
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
	if (expectedDiffHash !== EMPTY_DIFF_HASH) {
		const currentDiff = execSync("git diff --cached", {
			cwd: repoPath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			maxBuffer: 50 * 1024 * 1024,
		});
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
		assertExplicitPushTargetCurrent(repoPath, explicitPushTargetSnapshot);
	}

	// 5. Capture original HEAD, preserving a proven unborn branch as null.
	const originalHead = readOriginalHead(repoPath);

	// 6. Unstage everything so we can re-stage file-by-file. The default mixed
	//    reset works against both an existing HEAD and Git's empty unborn index.
	gitExecArgs(["reset", "--mixed"], repoPath);

	// 7. Commit loop (inter-commit reset after each commit)
	const committedShas: CommittedSha[] = [];

	try {
		for (const [i, plan] of plans.entries()) {
			const pendingFiles = collectPendingFiles(plans, i);
			try {
				// Stage the plan's files
				gitExecArgs(
					["--literal-pathspecs", "add", "--", ...plan.files],
					repoPath,
				);

				// Commit with temp message file
				const message = formatConventionalCommit(plan.commit);
				const tempMsgPath = path.join(
					os.tmpdir(),
					`commit-msg-${Date.now()}-${i}.txt`,
				);
				fs.writeFileSync(tempMsgPath, message, "utf-8");
				try {
					gitExecArgs(
						["commit", "--file", tempMsgPath, "--no-verify"],
						repoPath,
					);
				} finally {
					try {
						fs.unlinkSync(tempMsgPath);
					} catch {
						/* best-effort */
					}
				}

				// Capture the SHA
				const sha = execSync("git rev-parse HEAD", {
					cwd: repoPath,
					encoding: "utf-8",
				}).trim();
				committedShas.push({ sha, files: [...plan.files] });
			} catch (commitErr) {
				try {
					gitExecArgs(["reset", "--mixed"], repoPath);
				} catch (resetErr) {
					throw new GitExecError(
						`reset HEAD failed during cleanup: ${resetErr instanceof Error ? resetErr.message : String(resetErr)}. ` +
							`Original commit error: ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`,
						"reset",
						1,
					);
				}

				const fileState = inspectCommitPlanFileState(repoPath, plan.files);
				if (fileState.nonexistentFiles.length > 0) {
					throw new CommitPlanError(
						`Plan ${i + 1}/${plans.length} references file(s) that do not exist on disk or in Git: ${fileState.nonexistentFiles.join(", ")}.`,
						"nonexistent-file",
						[...fileState.nonexistentFiles],
						{
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
						originalHead,
						failedIndex: i,
						totalCount: plans.length,
						pendingFiles,
					},
				);
			}

			// Clear staging between plans
			try {
				gitExecArgs(["reset", "--mixed"], repoPath);
			} catch {
				/* best-effort */
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

	// 8. Publish. Never send landed commits back through LLM planning on failure.
	let pushRetryCount: number;
	let publishedSha: string | null;
	let remoteTrackingRefSynchronization: PushExecutionResult["remoteTrackingRefSynchronization"];
	try {
		if (explicitPushTargetSnapshot) {
			const publication = publishExplicitTargetSnapshot(
				repoPath,
				explicitPushTargetSnapshot,
				gitExecArgs(["rev-parse", "HEAD"], repoPath),
			);
			pushRetryCount = publication.retryCount;
			publishedSha = publication.publishedSha;
			// Explicit publication owns no local remote-tracking projection.
			remoteTrackingRefSynchronization = "not-applicable";
		} else {
			({
				retryCount: pushRetryCount,
				publishedSha,
				remoteTrackingRefSynchronization,
			} = executePush(repoPath, !!settings.autoPush));
		}
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
		committedShas,
		originalHead,
		pushRetryCount,
		publishedSha,
		remoteTrackingRefSynchronization,
	};
}
