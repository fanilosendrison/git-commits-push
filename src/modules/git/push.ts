import { PushError } from "../core/errors.ts";
import { gitExec } from "./git-exec.ts";

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

export function classifyTransient(msg: string): boolean {
	for (const sig of PERMANENT_PUSH_SIGNATURES) {
		if (msg.includes(sig)) return false;
	}
	return true;
}

export function executePush(repoPath: string, autoPush: boolean): void {
	if (!autoPush) return;

	const remotes = gitExec("remote", repoPath);
	if (!remotes) return;

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
}
