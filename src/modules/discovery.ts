/**
 * src/modules/discovery.ts — Phase 1: Repository Discovery
 *
 * Implements NIB-M-DISCOVERY §3.
 * Scans configured searchPaths for git repositories with dirty state.
 * Excludes repositories in detached HEAD state.
 */
import * as os from "node:os";
import * as path from "node:path";
import type { RepositoryInfo, Settings } from "../types.ts";
import {
	computeRepoId,
	findGitDirectoriesRecursively,
	hasLocalChanges,
	hasUnpushedCommits,
	isDetachedHead,
} from "../utils/git-utils.ts";

function expandPath(p: string): string {
	if (p.startsWith("~/")) {
		return path.join(os.homedir(), p.slice(2));
	}
	return p;
}

/**
 * Discover all git repositories with uncommitted or unpushed changes
 * within the configured search paths.
 */
export async function runDiscovery(settings: Settings): Promise<RepositoryInfo[]> {
	const searchPaths =
		settings.searchPaths.length > 0
			? settings.searchPaths
			: ["~/Developper/Projects"];

	const results: RepositoryInfo[] = [];
	const seen = new Set<string>();

	for (const root of searchPaths) {
		const expanded = expandPath(root);

		let repos: string[];
		try {
			repos = findGitDirectoriesRecursively(expanded);
		} catch {
			// Invalid or inaccessible path — log warning to stderr and continue
			process.stderr.write(`[discovery] Warning: cannot scan path ${expanded}\n`);
			continue;
		}

		for (const repoPath of repos) {
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
