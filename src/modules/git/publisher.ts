import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CommitPlan, CommittedSha, Settings } from "../../types.ts";
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
import { gitExec, gitExecArgs } from "./git-exec.ts";
import { executePush } from "./push.ts";

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

/**
 * Execute multiple commits (one per CommitPlan) then push once.
 * Returns the list of landed SHAs with their files and the original HEAD.
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
): Promise<{
	committedShas: CommittedSha[];
	originalHead: string;
	pushRetryCount: number;
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

	// 4. Capture original HEAD
	const originalHead = execSync("git rev-parse HEAD", {
		cwd: repoPath,
		encoding: "utf-8",
	}).trim();

	// 5. Unstage everything so we can re-stage file-by-file
	gitExec("reset HEAD", repoPath);

	// 6. Commit loop (inter-commit reset after each commit)
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
					gitExec("reset HEAD", repoPath);
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
						`${committedShas.length} commit(s) already in history (from ${originalHead.slice(0, 7)}). ` +
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
				gitExec("reset HEAD", repoPath);
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

	// 7. Push. Never send landed commits back through LLM planning on failure.
	let pushRetryCount: number;
	try {
		pushRetryCount = executePush(repoPath, !!settings.autoPush);
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

	return { committedShas, originalHead, pushRetryCount };
}
