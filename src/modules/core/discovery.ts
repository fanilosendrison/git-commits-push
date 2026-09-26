import type { InvocationScope, RepositoryInfo, Settings } from "../../types.ts";
import { computeRepoId, hasLocalChanges } from "../../utils/git-utils.ts";
import { buildExplicitPushSnapshot } from "../git/explicit-push.ts";
import { captureExplicitPushTargetSnapshot } from "../git/explicit-push-target.ts";
import { resolveExplicitPushDestination } from "../git/push-destination.ts";
import { captureTrackedPushSnapshot } from "../git/push-only.ts";
import {
	assertExecutableInvocationScope,
	assertInvocationScopeCurrent,
} from "../invocation/invocation-scope.ts";

export async function runDiscovery(
	settings: Settings,
	invocationScope: InvocationScope,
): Promise<RepositoryInfo[]> {
	assertExecutableInvocationScope(invocationScope);

	if (invocationScope.kind === "worktree") {
		return discoverWorktreeRepository(invocationScope, settings);
	}
	return discoverTargetedRepository(invocationScope);
}

/**
 * Ordinary invocation discovery: exactly the canonical invocation worktree,
 * with normal tracked-branch publication semantics.
 *
 * It never scans `settings.searchPaths`, never enumerates sibling worktrees,
 * and never attaches explicit publication authority.
 */
async function discoverWorktreeRepository(
	invocationScope: Extract<InvocationScope, { kind: "worktree" }>,
	settings: Settings,
): Promise<RepositoryInfo[]> {
	assertInvocationScopeCurrent(invocationScope);

	const repository = invocationScope.repository;
	const id = await computeRepoId(repository);

	if (hasLocalChanges(repository)) {
		return [{ id, path: repository, operation: "commit-and-push" }];
	}

	if (!settings.autoPush) return [];

	const pushSnapshot = captureTrackedPushSnapshot(repository);
	if (!pushSnapshot) return [];
	return [
		{
			id,
			path: repository,
			operation: "push-only",
			pushSnapshot,
		},
	];
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
