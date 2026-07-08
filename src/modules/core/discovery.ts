import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RepositoryInfo, Settings } from "../../types.ts";
import {
	computeRepoId,
	findGitDirectoriesRecursively,
	getWorktrees,
	hasLocalChanges,
	isDetachedHead,
} from "../../utils/git-utils.ts";

function expandPath(p: string): string {
	if (p.startsWith("~/")) {
		return path.join(os.homedir(), p.slice(2));
	}
	return p;
}

function canonicalizePath(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}

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
		const canonical = canonicalizePath(expanded);

		let repos: string[];
		try {
			repos = findGitDirectoriesRecursively(canonical);
		} catch {
			process.stderr.write(
				`[discovery] Warning: cannot scan path ${canonical}\n`,
			);
			continue;
		}

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
