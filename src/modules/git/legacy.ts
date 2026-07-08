import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gitExec, GIT_ENV } from "./exec.ts";
import { formatConventionalCommit } from "../formatters/commit-formatter.ts";
import type { CommitMessage, Settings } from "../../types.ts";

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
