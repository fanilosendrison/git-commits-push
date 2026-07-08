import { execSync } from "node:child_process";

/**
 * Reconstruct the remaining-work diff for retry or escalation contexts.
 *
 * When pendingFiles is present:
 *   - For each file, check worktree vs index (R73 worktree guard)
 *   - Re-stage safe files, capture `git diff --cached`
 *   - Reset to restore clean state
 *   - Include worktree-only diffs as-is
 *
 * When pendingFiles is empty/absent:
 *   - Best-effort read of `git diff --cached`
 *
 * Falls back to empty string if all reconstruction paths fail.
 */
export function reconstructRemainingDiff(
	repoPath: string,
	pendingFiles?: string[],
): string {
	if (pendingFiles && pendingFiles.length > 0) {
		const safeToRestage: string[] = [];
		const worktreeOnlyParts: string[] = [];

		for (const f of pendingFiles) {
			try {
				const worktreeVsIndex = execSync(
					`git diff -- "${f.replace(/"/g, '\\"')}"`,
					{
						cwd: repoPath,
						encoding: "utf-8",
						stdio: ["pipe", "pipe", "pipe"],
					},
				).toString();

				if (worktreeVsIndex) {
					// R73 fix: preserve worktree edits regardless of index status
					worktreeOnlyParts.push(worktreeVsIndex);
				} else {
					safeToRestage.push(f);
				}
			} catch {
				// File missing or git error — include in safeToRestage
				// and let the re-stage fail gracefully below
				safeToRestage.push(f);
			}
		}

		if (safeToRestage.length > 0) {
			const quoted = safeToRestage.map((f) => JSON.stringify(f)).join(" ");
			try {
				execSync(`git add -- ${quoted}`, {
					cwd: repoPath,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				});
				const cachedDiff = execSync("git diff --cached", {
					cwd: repoPath,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
					timeout: 30_000,
				}).toString();
				// Reset after capture
				try {
					execSync("git reset HEAD", {
						cwd: repoPath,
						encoding: "utf-8",
						stdio: ["pipe", "pipe", "pipe"],
					});
				} catch {
					// Best-effort cleanup
				}
				return cachedDiff + worktreeOnlyParts.join("\n");
			} catch {
				// Re-stage failed — return whatever worktree diffs we have
				return worktreeOnlyParts.join("\n");
			}
		}

		return worktreeOnlyParts.join("\n");
	}

	// No pendingFiles — read the full staged diff (best-effort)
	try {
		return execSync("git diff --cached", {
			cwd: repoPath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 30_000,
		}).toString();
	} catch {
		return "";
	}
}
