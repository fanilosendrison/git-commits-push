/**
 * src/git-utils.ts — Shared git utility functions.
 * Pure wrappers around git subcommands with stable return types.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

/** Execute a git command in the given directory, return trimmed stdout. Throws on non-zero exit. */
function gitExec(args: string, repoPath: string): string {
	return execSync(`git ${args}`, {
		cwd: repoPath,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	}).trim();
}

/**
 * Extract the staged diff and compute its SHA-256 hash.
 * Used by Phase 2 (validation) and Phase 4 (race-condition check).
 */
export function extractDiff(repoPath: string): Promise<{ diff: string; diffHash: string }> {
	const diff = execSync("git diff --cached", {
		cwd: repoPath,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	const diffHash = crypto.createHash("sha256").update(diff).digest("hex");
	return Promise.resolve({ diff, diffHash });
}

/**
 * Compute a deterministic unique ID for a repository path.
 * Uses SHA-256 of the real (symlink-resolved) absolute path.
 */
export function computeRepoId(repoPath: string): Promise<string> {
	const realPath = fs.existsSync(repoPath) ? fs.realpathSync(repoPath) : repoPath;
	const id = crypto.createHash("sha256").update(realPath).digest("hex").slice(0, 16);
	return Promise.resolve(id);
}

/**
 * Check if a repository is in a detached HEAD state.
 * A detached HEAD has no branch name — git branch --show-current returns empty string.
 */
export function isDetachedHead(repoPath: string): boolean {
	try {
		const branch = gitExec("branch --show-current", repoPath);
		return branch === "";
	} catch {
		// If git fails entirely (e.g., not a repo), treat as detached
		return true;
	}
}

/**
 * Check if the repository has any local changes (staged or unstaged).
 */
export function hasLocalChanges(repoPath: string): boolean {
	try {
		const status = gitExec("status --porcelain", repoPath);
		return status !== "";
	} catch {
		return false;
	}
}

/**
 * Check if the repository has commits not yet pushed to the upstream.
 * Falls back to git cherry -v if no upstream is tracked.
 */
export function hasUnpushedCommits(repoPath: string): boolean {
	try {
		const log = gitExec("log @{u}..HEAD --oneline", repoPath);
		return log !== "";
	} catch {
		// No upstream tracking branch — fallback to check if there are any commits not on any remote
		try {
			const unpushed = gitExec("log HEAD --not --remotes --oneline", repoPath);
			return unpushed !== "";
		} catch {
			return false;
		}
	}
}

/**
 * Recursively find all git repository root directories under the given root.
 * Stops recursion at a .git directory (does not descend into sub-repos).
 * Skips: node_modules, hidden directories other than .git itself.
 */
export function findGitDirectoriesRecursively(root: string): string[] {
	const results: string[] = [];

	function walk(dir: string): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			// Permission error or broken symlink — skip
			return;
		}

		const hasGit = entries.some((e) => e.isDirectory() && e.name === ".git");
		if (hasGit) {
			results.push(dir);
			// Do not recurse further — no nested git repos
			return;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			// Skip node_modules and hidden directories (except .git handled above)
			if (entry.name === "node_modules") continue;
			if (entry.name.startsWith(".")) continue;
			walk(path.join(dir, entry.name));
		}
	}

	if (fs.existsSync(root)) {
		walk(root);
	}

	return results;
}
