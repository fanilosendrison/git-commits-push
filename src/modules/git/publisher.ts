import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gitExec, GIT_ENV } from "./git-exec.ts";
import { formatConventionalCommit } from "../formatters/commit-formatter.ts";
import { executePush } from "./push.ts";
import {
	CommitPlanError,
	DiffHashMismatchError,
	GitExecError,
	PartialCommitError,
} from "../core/errors.ts";
import type { CommitPlan, CommittedSha, Settings } from "../../types.ts";

/**
 * Helper to normalize file paths for the duplicate file check.
 */
function normalizePath(p: string): string {
	return path.posix.normalize(p).replace(/\/+$/, "");
}

/**
 * Execute multiple commits (one per CommitPlan) then push once.
 * Returns the list of landed SHAs with their files and the original HEAD.
 *
 * @throws CommitPlanError — structural plan errors (empty, duplicate, missing, nonexistent)
 * @throws DiffHashMismatchError — staged diff changed during inference
 * @throws PartialCommitError — mid-loop failure after partial commits landed
 * @throws PushError — push failure (transient or permanent)
 */
export async function executeMultiCommitAndPush(
	repoPath: string,
	plans: CommitPlan[],
	expectedDiffHash: string,
	settings: Settings,
): Promise<{ committedShas: CommittedSha[]; originalHead: string }> {
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
	const currentDiff = execSync("git diff --cached", {
		cwd: repoPath,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		env: GIT_ENV,
	});
	const currentHash = crypto
		.createHash("sha256")
		.update(currentDiff)
		.digest("hex");
	if (currentHash !== expectedDiffHash) {
		throw new DiffHashMismatchError();
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
			try {
				// Stage the plan's files
				gitExec(
					`add -- ${plan.files.map((f) => JSON.stringify(f)).join(" ")}`,
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
					gitExec(`commit --file=${tempMsgPath} --no-verify`, repoPath);
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

				// Classify the commit failure
				const commitErrMsg =
					commitErr instanceof Error ? commitErr.message : String(commitErr);
				const commitErrStdout =
					commitErr && typeof commitErr === "object" && "stdout" in commitErr
						? String((commitErr as any).stdout)
						: "";
				const commitErrStderr =
					commitErr && typeof commitErr === "object" && "stderr" in commitErr
						? String((commitErr as any).stderr)
						: "";
				const msg =
					commitErrMsg + "\n" + commitErrStdout + "\n" + commitErrStderr;

				// Build pendingFiles context (files from this plan + subsequent plans)
				const pendingFilesSet = new Set<string>(plan.files);
				const pendingFilesContext = [
					...plan.files,
					...plans
						.slice(i + 1)
						.flatMap((p) => p.files)
						.filter((f) => {
							if (pendingFilesSet.has(f)) return false;
							pendingFilesSet.add(f);
							return true;
						}),
				];

				// File does not exist (git add failed before commit)
				if (
					msg.includes("did not match any file") ||
					msg.includes("pathspec") ||
					msg.includes("does not exist")
				) {
					throw new CommitPlanError(
						`Plan ${i + 1}/${plans.length} references file(s) that do not exist on disk: ${plan.files.join(", ")}. ` +
							`Files must exist relative to the repo root.`,
						"nonexistent-file",
						plan.files,
						{
							committedShas: [...committedShas],
							pendingFiles: pendingFilesContext,
						},
					);
				}

				// Nothing to commit (file already committed or empty)
				if (
					msg.includes("nothing to commit") ||
					msg.includes("nothing added to commit") ||
					msg.includes("no changes added")
				) {
					throw new CommitPlanError(
						`Plan ${i + 1}/${plans.length} has no changes to commit. Files: ${plan.files.join(", ")}`,
						"missing-file",
						plan.files,
						{
							committedShas: [...committedShas],
							pendingFiles: pendingFilesContext,
						},
					);
				}

				// Otherwise: partial commit failure
				const failedPlanFiles = [...plan.files];
				const subsequentFiles = plans.slice(i + 1).flatMap((p) => p.files);
				const seenFiles = new Set<string>(failedPlanFiles);
				const pendingFiles = [
					...failedPlanFiles,
					...subsequentFiles.filter((f) => {
						if (seenFiles.has(f)) return false;
						seenFiles.add(f);
						return true;
					}),
				];

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

	// 7. Push
	executePush(repoPath, !!settings.autoPush);

	return { committedShas, originalHead };
}
