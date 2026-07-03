/**
 * src/modules/discovery.ts — Phase 1: Repository Discovery
 *
 * Implements NIB-M-DISCOVERY §3.
 * Scans configured searchPaths for git repositories with dirty state.
 * Excludes repositories in detached HEAD state.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RepositoryInfo, Settings } from "../types.ts";
import {
	computeRepoId,
	findGitDirectoriesRecursively,
	getWorktrees,
	hasLocalChanges,
	isDetachedHead,
} from "../utils/git-utils.ts";

function expandPath(p: string): string {
	if (p.startsWith("~/")) {
		return path.join(os.homedir(), p.slice(2));
	}
	return p;
}

/**
 * Canonicalize a filesystem path so all downstream comparisons see the same
 * path representation. On macOS, `os.tmpdir()` returns `/var/folders/...`
 * but git (via `getWorktrees`) internally canonicalizes paths to
 * `/private/var/folders/...`. Without this normalization, the discovery
 * loop sees a mix of unresolved and canonical paths in the `seen` set and
 * `results`, causing duplicate detection misses and path mismatches downstream.
 *
 * If the path does not exist or `realpathSync` fails (e.g., permission error),
 * fall back to the original path — the subsequent `findGitDirectoriesRecursively`
 * call will surface the real error in its own try/catch.
 */
function canonicalizePath(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}

/**
 * Discover all git repositories with uncommitted or unpushed changes
 * within the configured search paths.
 */
export async function runDiscovery(
	settings: Settings,
): Promise<RepositoryInfo[]> {
	const searchPaths =
		settings.searchPaths.length > 0
			? settings.searchPaths
			: ["~/Developper/Projects"];

	const results: RepositoryInfo[] = [];
	const seen = new Set<string>();

	for (const root of searchPaths) {
		const expanded = expandPath(root);
		// Canonicalize the search path so discovered repos and their worktrees
		// share a consistent path prefix throughout the discovery loop.
		const canonical = canonicalizePath(expanded);

		let repos: string[];
		try {
			repos = findGitDirectoriesRecursively(canonical);
		} catch {
			// Invalid or inaccessible path — log warning to stderr and continue
			process.stderr.write(
				`[discovery] Warning: cannot scan path ${canonical}\n`,
			);
			continue;
		}

		// Expand discovered repositories with their git worktrees
		const allRepos: string[] = [];
		for (const repoPath of repos) {
			try {
				const worktrees = getWorktrees(repoPath);
				allRepos.push(...worktrees);
			} catch {
				allRepos.push(repoPath);
			}
		}

		for (const repoPath of allRepos) {
			if (seen.has(repoPath)) {
				continue;
			}
			seen.add(repoPath);

			if (isDetachedHead(repoPath)) {
				continue;
			}

			const isDirty = hasLocalChanges(repoPath);
			if (!isDirty) {
				continue;
			}

			const id = await computeRepoId(repoPath);
			results.push({ id, path: repoPath });
		}
	}

	return results;
}
