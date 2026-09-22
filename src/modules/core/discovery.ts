import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InvocationScope, RepositoryInfo, Settings } from "../../types.ts";
import {
	computeRepoId,
	findGitDirectoriesRecursively,
	getWorktrees,
	hasLocalChanges,
	isDetachedHead,
} from "../../utils/git-utils.ts";
import { buildExplicitPushSnapshot } from "../git/explicit-push.ts";
import { captureExplicitPushTargetSnapshot } from "../git/explicit-push-target.ts";
import { resolveExplicitPushDestination } from "../git/push-destination.ts";
import { captureTrackedPushSnapshot } from "../git/push-only.ts";
import { assertInvocationScopeCurrent } from "../invocation/invocation-scope.ts";

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
	invocationScope: InvocationScope,
): Promise<RepositoryInfo[]> {
	if (invocationScope.kind === "targeted") {
		return discoverTargetedRepository(invocationScope);
	}

	return discoverGlobalRepositories(settings);
}

/**
 * Targeted discovery validates one exact canonical worktree and returns only
 * that worktree. It never calls the global recursive scan, worktree
 * enumeration, or sibling/checkout expansion.
 *
 * The explicit destination is frozen before the worktree is inspected so the
 * remote baseline predates staging, validation, and every commit effect.
 */
async function discoverTargetedRepository(
	invocationScope: Extract<InvocationScope, { kind: "targeted" }>,
): Promise<RepositoryInfo[]> {
	assertInvocationScopeCurrent(invocationScope);

	const destination = resolveExplicitPushDestination(
		invocationScope.repository,
		{
			remote: invocationScope.pushRemote,
			destinationRef: invocationScope.pushRef,
		},
	);
	const explicitPushTargetSnapshot = captureExplicitPushTargetSnapshot(
		invocationScope.repository,
		destination,
	);
	const id = await computeRepoId(invocationScope.repository);

	if (hasLocalChanges(invocationScope.repository)) {
		return [
			{
				id,
				path: invocationScope.repository,
				operation: "commit-and-push",
				explicitPushTargetSnapshot,
			},
		];
	}

	// A clean exact worktree publishes only when its detached HEAD already
	// contains the frozen baseline. The frozen baseline is absolute: a remote
	// that advanced, or a local history that no longer contains it, fails closed
	// because converging them is outside git-commits-push.
	const pushSnapshot = buildExplicitPushSnapshot(
		invocationScope.repository,
		explicitPushTargetSnapshot,
	);
	if (!pushSnapshot) return [];
	return [
		{
			id,
			path: invocationScope.repository,
			operation: "push-only",
			pushSnapshot,
		},
	];
}

async function discoverGlobalRepositories(
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
			if (isDirty) {
				const id = await computeRepoId(repoPath);
				results.push({ id, path: repoPath, operation: "commit-and-push" });
				continue;
			}
			if (!settings.autoPush) continue;

			const pushSnapshot = captureTrackedPushSnapshot(repoPath);
			if (!pushSnapshot) continue;
			const id = await computeRepoId(repoPath);
			results.push({
				id,
				path: repoPath,
				operation: "push-only",
				pushSnapshot,
			});
		}
	}

	// Order submodules before their parents so that submodule commits
	// land first. The parent diff will then include the updated SHA.
	results.sort(
		(a, b) => b.path.split(path.sep).length - a.path.split(path.sep).length,
	);

	return results;
}
