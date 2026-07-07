/**
 * src/modules/git-publisher.ts — Phase 3/4: Commit & Push (the "publisher")
 *
 * Implements NIB-M-GIT-EXECUTION §3.
 * All git subcommands run with GIT_TERMINAL_PROMPT=0 (Global Invariant I1).
 *
 * Phase 3 refactor (plan unified-retry-on-all-catches):
 *   - Typed errors (CommitPlanError, DiffHashMismatchError, PartialCommitError, PushError)
 *   - Return { committedShas, originalHead } instead of void
 *   - Path normalization in duplicate-file guard (R56)
 *   - No leading git reset HEAD (Decision 8)
 *   - Inter-commit reset (Decision 10)
 *   - Mid-loop failure classification (R59)
 *   - Push transient classification (R10, R60)
 */

import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	CommitMessage,
	CommitPlan,
	CommittedSha,
	Settings,
} from "../types.ts";
import {
	CommitPlanError,
	DiffHashMismatchError,
	GitExecError,
	PartialCommitError,
	PushError,
} from "./errors.ts";

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

/**
 * Run a git command and return trimmed stdout.
 * Throws on non-zero exit with stderr in the error message.
 */
function gitExec(args: string, cwd: string): string {
	return execSync(`git ${args}`, {
		cwd,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		env: GIT_ENV,
	}).trim();
}

// ── Push transient classification ───────────────────────────────────────────

/**
 * Substrings that identify permanent push failures (auth, permissions, etc.).
 * Matched via `msg.includes(sig)` — order matters: more specific first.
 * Plan ref: R60 — loaded from fixture; defined inline for v1.
 */
const PERMANENT_PUSH_SIGNATURES: readonly string[] = [
	"Permission denied",
	"Authentication failed",
	"repository not found",
	"Repository not found",
	"access denied",
	"Access denied",
	"could not read from remote",
	"does not appear to be a git repository",
	"not authorized",
	"Not authorized",
	"403",
	"401",
];

/**
 * Classify a git push error message as transient (retryable) or permanent.
 * Returns `false` for permanent errors, `true` for transient/unknown.
 *
 * Plan ref: R10 — classifyTransient helper, R60 — signature list.
 */
export function classifyTransient(msg: string): boolean {
	for (const sig of PERMANENT_PUSH_SIGNATURES) {
		if (msg.includes(sig)) return false;
	}
	return true;
}

// ── formatConventionalCommit ─────────────────────────────────────────────────

/**
 * Format a CommitMessage into a Conventional Commits string.
 * Pure function — no I/O, no side effects.
 */
export function formatConventionalCommit(commit: CommitMessage): string {
	let message = commit.type;
	if (commit.scope) {
		message += `(${commit.scope})`;
	}
	if (commit.isBreaking) {
		message += "!";
	}
	message += `: ${commit.description}`;

	if (commit.body) {
		message += `\n\n${commit.body}`;
	}

	return message;
}

// ── executeCommitAndPush (legacy, single commit) ─────────────────────────────

/**
 * Execute a single commit and optional push for backward compatibility.
 * Legacy path (R25) — kept for existing tests U-GE-06–U-GE-11.
 *
 * Throws generic Error for backward compatibility.
 */
export async function executeCommitAndPush(
	repoPath: string,
	commit: CommitMessage,
	expectedDiffHash: string,
	settings: Settings,
): Promise<void> {
	// 1. Race Condition Protection
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
		throw new Error(
			"DiffHash mismatch: The staged diff changed during LLM inference.",
		);
	}

	// 2. Build commit message and write to temp file
	const message = formatConventionalCommit(commit);
	const tempMsgPath = path.join(os.tmpdir(), `commit-msg-${Date.now()}.txt`);
	fs.writeFileSync(tempMsgPath, message, "utf-8");

	// 3. Execute commit
	gitExec(`commit --file=${tempMsgPath} --no-verify`, repoPath);

	try {
		fs.unlinkSync(tempMsgPath);
	} catch {
		// Best-effort cleanup
	}

	// 4. Push Network Logic
	if (!settings.autoPush) return;

	const remotes = gitExec("remote", repoPath);
	if (!remotes) return;

	try {
		gitExec("push", repoPath);
	} catch (pushErr) {
		const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
		if (msg.includes("has no upstream branch") || msg.includes("no upstream")) {
			const branchName = gitExec("branch --show-current", repoPath);
			const firstRemote = remotes.split("\n")[0]?.trim() ?? "origin";
			gitExec(`push -u ${firstRemote} ${branchName}`, repoPath);
		} else {
			throw new Error(`Push Error: ${msg}`);
		}
	}
}

// ── executeMultiCommitAndPush (refactored v2) ────────────────────────────────

/**
 * Execute multiple commits (one per CommitPlan) then push once.
 * Returns the list of landed SHAs with their files and the original HEAD.
 *
 * Plan ref: Phase 3 — refactored signature, typed errors, mid-loop handling.
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

	// 2. Duplicate file guard with path normalization (R56 + U-GE-43)
	//    Normalize via path.posix.normalize() + trailing slash removal to catch:
	//    - src/foo.ts vs src/./foo.ts (R56)
	//    - src/foo.ts vs src/bar/../foo.ts (R56)
	//    - src/foo.ts vs src//foo.ts (R56)
	//    - src/foo.ts vs src/foo.ts/ (trailing slash)
	function normalizePath(p: string): string {
		return path.posix.normalize(p).replace(/\/+$/, "");
	}
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
	//    Note: the plan (Decision 8) says no leading reset, but in our flow
	//    the orchestrator has already staged everything via processRepoValidationAndDiff.
	//    Without this reset, Plan 1's commit includes ALL staged files, not just Plan 1's.
	gitExec("reset HEAD", repoPath);

	// 6. Commit loop (inter-commit reset after each commit, Decision 10)
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
				// R74 fix: git reset HEAD is FATAL on failure (was logged-but-non-fatal in R8).
				// If reset fails, the staging area remains dirty and the next retry's `git add`
				// is a no-op → the next commit silently includes the failed plan's files.
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
				// "nothing to commit" goes to stdout, not stderr (git behavior)
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

				// Build pendingFiles context (R59) — files from this plan + subsequent plans
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

				// 2a. File does not exist (git add failed before commit)
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

				// 2b. Nothing to commit (file already committed or empty)
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

				// 2c. Otherwise: partial commit failure
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

			// 3. Inter-commit reset (Decision 10):
			//    Clear staging between plans so the next plan's `add` does not include
			//    files from this commit. Runs ONLY on success path — on failure, the
			//    catch block above already issued the reset and threw.
			try {
				gitExec("reset HEAD", repoPath);
			} catch {
				// Best-effort: if reset fails here (rare), the next git add will
				// overwrite the index for the files it touches.
			}
		}
	} catch (err) {
		// Re-throw typed errors as-is; wrap unexpected errors in GitExecError
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
	if (!settings.autoPush) {
		return { committedShas, originalHead };
	}

	const remotes = gitExec("remote", repoPath);
	if (!remotes) {
		return { committedShas, originalHead };
	}

	try {
		gitExec("push", repoPath);
	} catch (pushErr) {
		const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
		if (msg.includes("has no upstream branch") || msg.includes("no upstream")) {
			const branchName = gitExec("branch --show-current", repoPath).trim();
			if (!branchName) {
				throw new PushError(
					`Push failed: detached HEAD, cannot determine upstream branch. ${msg}`,
					false,
				);
			}
			const firstRemote = remotes.split("\n")[0]?.trim() ?? "origin";
			try {
				gitExec(`push -u ${firstRemote} ${branchName}`, repoPath);
				return { committedShas, originalHead };
			} catch (innerErr) {
				const innerMsg =
					innerErr instanceof Error ? innerErr.message : String(innerErr);
				throw new PushError(
					`Push with upstream failed: ${innerMsg}`,
					classifyTransient(innerMsg),
				);
			}
		} else {
			throw new PushError(`Push failed: ${msg}`, classifyTransient(msg));
		}
	}

	return { committedShas, originalHead };
}
