/**
 * src/modules/git/explicit-push.ts — Publication through a frozen explicit
 * destination.
 *
 * Explicit-target publication never consults or mutates a source branch, an
 * upstream, a local tracking ref, or any persistent Git configuration. Exact
 * SHAs are published through the generic exact-SHA primitives with the frozen
 * baseline as the lease expectation, and the destination is read back before
 * success is reported. A destination that moved away from the frozen baseline
 * fails closed; convergence stays outside git-commits-push.
 */
import type {
	ExplicitPushSnapshot,
	ExplicitPushTargetSnapshot,
	RemoteTrackingRefSynchronization,
	RepositoryInfo,
	Settings,
} from "../../types.ts";
import { PushError } from "../core/errors.ts";
import {
	runTestCascade,
	type SecretScanner,
	validateDiffForSecrets,
} from "../core/validators/pre-commit-validators.ts";
import {
	explicitDestinationDivergedError,
	explicitDestinationMovedError,
	openFrozenExplicitEndpoint,
	readExplicitDestinationSha,
	readHeadSha,
} from "./explicit-push-target.ts";
import { gitExecArgs } from "./git-exec.ts";
import {
	assertOutgoingCommitsMatch,
	isAncestor,
	readCommitPatches,
	readOrderedOutgoingShas,
} from "./outgoing-commits.ts";
import {
	assertFastForwardPublication,
	classifyTransient,
	publishWithFrozenEndpoint,
} from "./push.ts";
import { sanitizePushDiagnostic } from "./push-diagnostic-sanitizer.ts";
import type { ResolvedPushEndpoint } from "./push-endpoint.ts";

export interface ExplicitTargetPublication {
	readonly retryCount: number;
	readonly publishedSha: string;
}

/**
 * Publish one exact source SHA to the frozen explicit destination.
 *
 * The destination must be either already at `sourceSha` (idempotent success) or
 * still at the frozen baseline. Any other destination SHA fails closed without
 * touching it. The frozen baseline is the lease expectation, so a concurrent
 * advance between the read and the push is rejected by the remote itself.
 */
export function publishExactExplicitTarget(
	repository: string,
	pushEndpoint: ResolvedPushEndpoint,
	destinationRef: string,
	destinationBaselineSha: string,
	sourceSha: string,
): ExplicitTargetPublication {
	const observedSha = readExplicitDestinationSha(pushEndpoint, destinationRef);
	if (observedSha === sourceSha) {
		return { retryCount: 0, publishedSha: sourceSha };
	}
	if (observedSha !== destinationBaselineSha) {
		throw explicitDestinationMovedError(
			destinationRef,
			destinationBaselineSha,
			observedSha,
		);
	}
	assertFastForwardPublication(repository, destinationBaselineSha, sourceSha);
	const retryCount = publishWithFrozenEndpoint(
		pushEndpoint,
		destinationRef,
		destinationBaselineSha,
		sourceSha,
	);
	const postflightSha = readExplicitDestinationSha(
		pushEndpoint,
		destinationRef,
	);
	if (postflightSha !== sourceSha) {
		throw new PushError(
			"Explicit push completed without updating the destination to the exact source commit.",
			false,
			retryCount,
		);
	}
	return { retryCount, publishedSha: sourceSha };
}

/** Publish the exact current HEAD of a worktree to its frozen explicit target. */
export function publishExplicitTargetSnapshot(
	repository: string,
	snapshot: ExplicitPushTargetSnapshot,
	sourceSha: string,
): ExplicitTargetPublication {
	const pushEndpoint = openFrozenExplicitEndpoint(repository, snapshot);
	return publishExactExplicitTarget(
		repository,
		pushEndpoint,
		snapshot.destinationRef,
		snapshot.destinationBaselineSha,
		sourceSha,
	);
}

/**
 * Build the explicit push-only snapshot for a clean worktree whose HEAD is
 * strictly ahead of the frozen baseline. A baseline that is not an ancestor of
 * HEAD means the worktree and the destination diverged, which is never
 * converged automatically.
 */
export function buildExplicitPushSnapshot(
	repository: string,
	frozenTarget: ExplicitPushTargetSnapshot,
): ExplicitPushSnapshot | null {
	const validatedHeadSha = readHeadSha(repository);
	if (validatedHeadSha === frozenTarget.destinationBaselineSha) return null;
	if (
		!isAncestor(
			repository,
			frozenTarget.destinationBaselineSha,
			validatedHeadSha,
		)
	) {
		throw explicitDestinationDivergedError(
			frozenTarget.destinationRef,
			frozenTarget.destinationBaselineSha,
			validatedHeadSha,
		);
	}
	const outgoingShas = readOrderedOutgoingShas(
		repository,
		frozenTarget.destinationBaselineSha,
		validatedHeadSha,
	);
	if (outgoingShas.length === 0) return null;
	return {
		kind: "explicit",
		validatedHeadSha,
		remote: frozenTarget.remote,
		destinationRef: frozenTarget.destinationRef,
		destinationBaselineSha: frozenTarget.destinationBaselineSha,
		outgoingShas,
		pushUrlFingerprint: frozenTarget.pushUrlFingerprint,
	};
}

export interface ExplicitPushOnlyPublicationResult {
	readonly pushedShas: string[];
	readonly publishedSha: string;
	readonly remoteTrackingRefSynchronization: RemoteTrackingRefSynchronization;
}

/**
 * Republish a clean worktree whose HEAD already contains the frozen baseline.
 * `autoPush` is a global-discovery policy and never gates this path.
 */
export async function validateAndPushExplicitSnapshot(
	repository: RepositoryInfo,
	snapshot: ExplicitPushSnapshot,
	settings: Settings,
	scanner?: SecretScanner,
): Promise<ExplicitPushOnlyPublicationResult> {
	if (!settings.skipTests) await runTestCascade(repository.path);

	const currentHead = readHeadSha(repository.path);
	const worktreeStatus = gitExecArgs(
		["status", "--porcelain=v1", "--untracked-files=all"],
		repository.path,
	);
	if (currentHead !== snapshot.validatedHeadSha || worktreeStatus.length > 0) {
		throw new PushError(
			"Repository HEAD or worktree changed after explicit push-only validation.",
			false,
		);
	}
	assertOutgoingCommitsMatch(repository.path, snapshot, "Explicit push-only");
	const patches = readCommitPatches(repository.path, snapshot.outgoingShas);
	await validateDiffForSecrets(repository, patches, scanner);

	const pushEndpoint = openFrozenExplicitEndpoint(repository.path, snapshot);
	const observedSha = readExplicitDestinationSha(
		pushEndpoint,
		snapshot.destinationRef,
	);
	if (
		observedSha !== snapshot.validatedHeadSha &&
		observedSha !== snapshot.destinationBaselineSha
	) {
		throw explicitDestinationMovedError(
			snapshot.destinationRef,
			snapshot.destinationBaselineSha,
			observedSha,
		);
	}
	try {
		const publication = publishExactExplicitTarget(
			repository.path,
			pushEndpoint,
			snapshot.destinationRef,
			snapshot.destinationBaselineSha,
			snapshot.validatedHeadSha,
		);
		return {
			pushedShas: [...snapshot.outgoingShas],
			publishedSha: publication.publishedSha,
			remoteTrackingRefSynchronization: "not-applicable",
		};
	} catch (error) {
		throw wrapExplicitPublicationFailure(error);
	}
}

/** A failed explicit publication stays terminal and keeps its sanitized cause. */
function wrapExplicitPublicationFailure(error: unknown): PushError {
	if (error instanceof PushError) {
		return new PushError(
			`Explicit push-only publication failed: ${sanitizePushDiagnostic(error.message)}`,
			error.transient,
			error.retryCount,
		);
	}
	const rawMessage = error instanceof Error ? error.message : String(error);
	return new PushError(
		`Explicit push-only publication failed: ${sanitizePushDiagnostic(rawMessage)}`,
		classifyTransient(rawMessage),
	);
}
