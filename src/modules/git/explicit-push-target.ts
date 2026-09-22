/**
 * src/modules/git/explicit-push-target.ts — Authority for the frozen explicit
 * destination of one targeted invocation.
 *
 * The caller names one remote branch. This module freezes the remotely observed
 * baseline before any commit effect exists, proves the frozen endpoint and its
 * fingerprint are still current, and reconciles a persisted frozen target with
 * the durable invocation scope. It never publishes and never mutates
 * configuration.
 *
 * A destination that moved away from the frozen baseline fails closed:
 * fetching, rebasing, merging, and conflict resolution stay outside
 * git-commits-push.
 */
import type {
	ExplicitPushDestination,
	ExplicitPushTargetSnapshot,
	InvocationScope,
} from "../../types.ts";
import { PushError } from "../core/errors.ts";
import { gitExecArgs } from "./git-exec.ts";
import { classifyTransient } from "./push.ts";
import { resolveExplicitPushDestination } from "./push-destination.ts";
import { sanitizePushDiagnostic } from "./push-diagnostic-sanitizer.ts";
import {
	type ResolvedPushEndpoint,
	resolveSinglePushEndpoint,
} from "./push-endpoint.ts";

/**
 * Terminal, non-transient diagnostic for a destination that no longer equals
 * the frozen baseline. It carries no URL and no credential, and it states the
 * boundary explicitly so a calling agent knows convergence is its own work.
 */
export function explicitDestinationMovedError(
	destinationRef: string,
	expectedSha: string,
	observedSha: string | null,
): PushError {
	return new PushError(
		`Explicit push destination ${destinationRef} no longer matches the frozen baseline: expected ${expectedSha}, observed ${observedSha ?? "missing"}. Remote target moved; automatic merge or rebase is outside git-commits-push.`,
		false,
	);
}

/** Terminal diagnostic for a local history that no longer contains the baseline. */
export function explicitDestinationDivergedError(
	destinationRef: string,
	baselineSha: string,
	headSha: string,
): PushError {
	return new PushError(
		`Explicit push destination ${destinationRef} has diverged from local history: frozen baseline ${baselineSha} is not an ancestor of HEAD ${headSha}. Automatic merge or rebase is outside git-commits-push.`,
		false,
	);
}

/** Read the exact current HEAD of a worktree. */
export function readHeadSha(repository: string): string {
	return gitExecArgs(["rev-parse", "HEAD"], repository);
}

/** Read one destination ref through a frozen endpoint without exposing the URL. */
export function readExplicitDestinationSha(
	pushEndpoint: ResolvedPushEndpoint,
	destinationRef: string,
): string | null {
	try {
		return pushEndpoint.readOptionalDestinationSha(destinationRef);
	} catch (error) {
		const rawMessage = error instanceof Error ? error.message : String(error);
		throw new PushError(
			`Cannot verify explicit push destination: ${sanitizePushDiagnostic(rawMessage)}`,
			classifyTransient(rawMessage),
		);
	}
}

/**
 * Freeze the explicit destination: revalidate the named remote and ref, prove
 * there is exactly one effective push URL, and record the current destination
 * SHA. A destination branch that does not exist yet fails closed here; explicit
 * publication never creates an empty remote branch.
 */
export function captureExplicitPushTargetSnapshot(
	repository: string,
	destination: ExplicitPushDestination,
): ExplicitPushTargetSnapshot {
	const resolved = resolveExplicitPushDestination(repository, destination);
	const pushEndpoint = resolveSinglePushEndpoint(repository, resolved.remote);
	const destinationBaselineSha = pushEndpoint.readOptionalDestinationSha(
		resolved.destinationRef,
	);
	if (!destinationBaselineSha) {
		throw new PushError(
			`Explicit push destination ${resolved.destinationRef} does not exist on remote ${resolved.remote}; explicit publication requires an existing destination branch.`,
			false,
		);
	}
	return Object.freeze({
		remote: resolved.remote,
		destinationRef: resolved.destinationRef,
		destinationBaselineSha,
		pushUrlFingerprint: pushEndpoint.fingerprint,
	});
}

/**
 * Re-resolve the frozen endpoint of a snapshot and prove its fingerprint is
 * unchanged. Any endpoint change invalidates the frozen baseline, because the
 * observation and the publication would otherwise target different stores.
 */
export function openFrozenExplicitEndpoint(
	repository: string,
	snapshot: Pick<
		ExplicitPushTargetSnapshot,
		"remote" | "destinationRef" | "pushUrlFingerprint"
	>,
): ResolvedPushEndpoint {
	const resolved = resolveExplicitPushDestination(repository, {
		remote: snapshot.remote,
		destinationRef: snapshot.destinationRef,
	});
	const pushEndpoint = resolveSinglePushEndpoint(repository, resolved.remote);
	if (pushEndpoint.fingerprint !== snapshot.pushUrlFingerprint) {
		throw new PushError(
			`Explicit remote push URL changed after ${snapshot.destinationRef} was frozen; refusing stale explicit publication.`,
			false,
		);
	}
	return pushEndpoint;
}

/**
 * Prove the frozen destination is untouched before new history is created.
 * Called immediately before the first commit so a remote that advanced during
 * validation can never receive a commit built on a stale baseline.
 */
export function assertExplicitPushTargetCurrent(
	repository: string,
	snapshot: ExplicitPushTargetSnapshot,
): void {
	const pushEndpoint = openFrozenExplicitEndpoint(repository, snapshot);
	const observedSha = readExplicitDestinationSha(
		pushEndpoint,
		snapshot.destinationRef,
	);
	if (observedSha !== snapshot.destinationBaselineSha) {
		throw explicitDestinationMovedError(
			snapshot.destinationRef,
			snapshot.destinationBaselineSha,
			observedSha,
		);
	}
}

/**
 * Resolve the frozen explicit target that governs a targeted commit-and-push.
 *
 * A targeted invocation publishes only through its own frozen destination, so a
 * missing or mismatched snapshot is a fail-closed invariant violation rather
 * than something to repair. The remote baseline is never recaptured: a retry
 * keeps the same frozen authority as the original invocation.
 */
export function resolveFrozenExplicitTarget(
	scope: InvocationScope,
	repository: string,
	snapshot: ExplicitPushTargetSnapshot | undefined,
): ExplicitPushTargetSnapshot | undefined {
	if (scope.kind !== "targeted") {
		if (snapshot) {
			throw new Error(
				"A global invocation must not carry a frozen explicit push target.",
			);
		}
		return undefined;
	}
	if (!snapshot) {
		throw new Error(
			`Targeted commit-and-push for ${repository} is missing its frozen explicit push target.`,
		);
	}
	if (repository !== scope.repository) {
		throw new Error(
			`Targeted invocation must operate on ${scope.repository}; observed ${repository}.`,
		);
	}
	if (
		snapshot.remote !== scope.pushRemote ||
		snapshot.destinationRef !== scope.pushRef
	) {
		throw new Error(
			"Frozen explicit push target no longer matches the persisted targeted invocation scope.",
		);
	}
	return snapshot;
}
