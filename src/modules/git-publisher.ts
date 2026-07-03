/**
 * src/modules/git-publisher.ts — Phase 4: Commit & Push (the "publisher")
 *
 * Implements NIB-M-GIT-EXECUTION §3.
 * All git subcommands run with GIT_TERMINAL_PROMPT=0 (Global Invariant I1).
 */

import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CommitMessage, CommitPlan, Settings } from "../types.ts";

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

function gitExec(args: string, cwd: string): string {
	return execSync(`git ${args}`, {
		cwd,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		env: GIT_ENV,
	}).trim();
}

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

/**
 * Execute the commit and optional push for a single repository.
 * Implements NIB-M-GIT-EXECUTION §3 exactly.
 *
 * Throws on:
 *   - diffHash mismatch (race condition protection, NIB-S §6 P2)
 *   - Real network push failure (non-upstream-missing errors)
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

	// 2. Build commit message and write to temp file (avoids shell escaping issues)
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
	if (!settings.autoPush) {
		return;
	}

	const remotes = gitExec("remote", repoPath);
	if (!remotes) {
		// No remote configured — skip push gracefully (NIB-M-GIT-EXECUTION §4)
		return;
	}

	try {
		gitExec("push", repoPath);
	} catch (pushErr) {
		const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
		// Fallback: no upstream branch configured
		if (msg.includes("has no upstream branch") || msg.includes("no upstream")) {
			const branchName = gitExec("branch --show-current", repoPath);
			const firstRemote = remotes.split("\n")[0]?.trim() ?? "origin";
			gitExec(`push -u ${firstRemote} ${branchName}`, repoPath);
		} else {
			throw new Error(`Push Error: ${msg}`);
		}
	}
}

/**
 * Execute multiple commits (one per CommitPlan) then push once.
 * Implements the file-level commit splitting strategy (Option 1).
 *
 * Steps:
 *   1. Race condition check (diffHash must still match the full staged diff).
 *   2. git reset HEAD — unstage everything.
 *   3. For each CommitPlan: git add <files>, git commit.
 *   4. Push once at the end (same logic as executeCommitAndPush).
 *
 * Throws on:
 *   - diffHash mismatch
 *   - git add failure (e.g. hallucinated filename not in staging)
 *   - Real network push failure
 */
export async function executeMultiCommitAndPush(
	repoPath: string,
	plans: CommitPlan[],
	expectedDiffHash: string,
	settings: Settings,
): Promise<void> {
	if (plans.length === 0) {
		throw new Error(
			"executeMultiCommitAndPush: received an empty plans array.",
		);
	}

	// Guard: detect duplicate files across plans before touching git.
	// A file appearing in two plans means the LLM violated the Fat Commit rule.
	const seen = new Set<string>();
	for (const plan of plans) {
		for (const file of plan.files) {
			if (seen.has(file)) {
				throw new Error(
					`Invalid commit plan: file "${file}" appears in multiple plans. ` +
						`Files that contain multiple concerns must be grouped into a single Fat Commit plan.`,
				);
			}
			seen.add(file);
		}
	}

	// 1. Race condition protection — check the full staged diff hasn't changed
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

	// 2. Unstage everything so we can re-stage file-by-file
	gitExec("reset HEAD", repoPath);

	// 3. Commit each plan
	for (const plan of plans) {
		gitExec(
			`add -- ${plan.files.map((f) => JSON.stringify(f)).join(" ")}`,
			repoPath,
		);

		const message = formatConventionalCommit(plan.commit);
		const tempMsgPath = path.join(os.tmpdir(), `commit-msg-${Date.now()}.txt`);
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
	}

	// 4. Push once
	if (!settings.autoPush) return;

	const remotes = gitExec("remote", repoPath);
	if (!remotes) return; // No remote — skip gracefully

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
