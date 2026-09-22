import type {
	RemoteTrackingRefSynchronization,
	RepositoryInfo,
	Settings,
	TrackedPushSnapshot,
} from "../../types.ts";
import { PushError } from "../core/errors.ts";
import {
	runTestCascade,
	type SecretScanner,
	validateDiffForSecrets,
} from "../core/validators/pre-commit-validators.ts";
import { gitExecArgs } from "./git-exec.ts";
import {
	assertOutgoingCommitsMatch,
	isAncestor,
	readCommitPatches,
	readOrderedOutgoingShas,
} from "./outgoing-commits.ts";
import { classifyTransient } from "./push.ts";
import {
	resolveTrackedPushDestination,
	type TrackedPushDestination,
} from "./push-destination.ts";
import { sanitizePushDiagnostic } from "./push-diagnostic-sanitizer.ts";
import {
	type ResolvedPushEndpoint,
	resolveSinglePushEndpoint,
} from "./push-endpoint.ts";
import { synchronizeVerifiedRemoteTrackingRef } from "./remote-tracking-ref.ts";

function readOptionalGit(
	args: readonly string[],
	repoPath: string,
): string | null {
	try {
		const value = gitExecArgs(args, repoPath);
		return value || null;
	} catch {
		return null;
	}
}

/** Capture a clean tracked branch whose HEAD contains commits absent at push. */
export function captureTrackedPushSnapshot(
	repoPath: string,
): TrackedPushSnapshot | null {
	const sourceBranch = readOptionalGit(
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		repoPath,
	);
	if (!sourceBranch) return null;
	const destination = resolveTrackedPushDestination(repoPath, sourceBranch);
	if (!destination) return null;
	const pushEndpoint = resolveSinglePushEndpoint(repoPath, destination.remote);
	let destinationBaselineSha: string;
	try {
		destinationBaselineSha = pushEndpoint.readDestinationSha(
			destination.destinationRef,
		);
	} catch (error) {
		const message = sanitizePushDiagnostic(
			error instanceof Error ? error.message : String(error),
		);
		throw new Error(`Cannot inspect tracked push destination: ${message}`);
	}

	const validatedHeadSha = gitExecArgs(["rev-parse", "HEAD"], repoPath);
	if (isAncestor(repoPath, validatedHeadSha, destinationBaselineSha))
		return null;
	if (!isAncestor(repoPath, destinationBaselineSha, validatedHeadSha)) {
		throw new Error(
			`Tracked branch has diverged from ${destination.destinationRef}; refusing automatic push.`,
		);
	}
	const outgoingShas = readOrderedOutgoingShas(
		repoPath,
		destinationBaselineSha,
		validatedHeadSha,
	);
	if (outgoingShas.length === 0) return null;

	return {
		kind: "tracked",
		sourceBranch,
		validatedHeadSha,
		upstreamRef: destination.upstreamRef,
		remote: destination.remote,
		destinationRef: destination.destinationRef,
		destinationBaselineSha,
		outgoingShas,
		pushUrlFingerprint: pushEndpoint.fingerprint,
	};
}

function readRemoteDestinationSha(
	pushEndpoint: ResolvedPushEndpoint,
	snapshot: TrackedPushSnapshot,
): string {
	try {
		return pushEndpoint.readDestinationSha(snapshot.destinationRef);
	} catch (error) {
		const rawMessage = error instanceof Error ? error.message : String(error);
		const message = sanitizePushDiagnostic(rawMessage);
		throw new PushError(
			`Cannot verify push-only destination: ${message}`,
			classifyTransient(rawMessage),
		);
	}
}

/**
 * Resolve the ambiguous outcome of a failed exact push. A transport failure can
 * occur after the destination already received the validated HEAD, so the
 * destination is read back before the failure is accepted. This returns the
 * observed destination SHA only when it proves the intended publication, and
 * otherwise throws so an uncertain failure is never reported as success.
 */
export function resolveUncertainPushOnlyPublication(
	pushEndpoint: Pick<ResolvedPushEndpoint, "readOptionalDestinationSha">,
	snapshot: Pick<
		TrackedPushSnapshot,
		"destinationRef" | "destinationBaselineSha" | "validatedHeadSha"
	>,
	pushError: PushError,
): string {
	let observedSha: string | null = null;
	try {
		observedSha = pushEndpoint.readOptionalDestinationSha(
			snapshot.destinationRef,
		);
	} catch {
		observedSha = null;
	}
	if (observedSha === snapshot.validatedHeadSha) return observedSha;
	if (observedSha !== null && observedSha !== snapshot.destinationBaselineSha) {
		throw new PushError(
			"Push destination changed while recovering an uncertain push-only publication; refusing automatic retry.",
			false,
		);
	}
	throw pushError;
}

interface RevalidatedTrackedPushSnapshot {
	readonly state: "pending" | "already-pushed";
	readonly destination: TrackedPushDestination;
}

function revalidateTrackedPushSnapshot(
	repoPath: string,
	snapshot: TrackedPushSnapshot,
	pushEndpoint: ResolvedPushEndpoint,
): RevalidatedTrackedPushSnapshot {
	const currentBranch = gitExecArgs(
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		repoPath,
	);
	const currentHead = gitExecArgs(["rev-parse", "HEAD"], repoPath);
	const worktreeStatus = gitExecArgs(
		["status", "--porcelain=v1", "--untracked-files=all"],
		repoPath,
	);
	if (
		currentBranch !== snapshot.sourceBranch ||
		currentHead !== snapshot.validatedHeadSha ||
		worktreeStatus.length > 0
	) {
		throw new PushError(
			"Repository branch, HEAD, or worktree changed after push-only validation.",
			false,
		);
	}

	const currentDestination = resolveTrackedPushDestination(
		repoPath,
		snapshot.sourceBranch,
	);
	if (
		!currentDestination ||
		currentDestination.upstreamRef !== snapshot.upstreamRef ||
		currentDestination.remote !== snapshot.remote ||
		currentDestination.destinationRef !== snapshot.destinationRef
	) {
		throw new PushError(
			"Tracked push destination changed after validation; refusing stale push.",
			false,
		);
	}

	const remoteDestinationSha = readRemoteDestinationSha(pushEndpoint, snapshot);
	if (remoteDestinationSha === snapshot.validatedHeadSha) {
		return { state: "already-pushed", destination: currentDestination };
	}
	if (remoteDestinationSha !== snapshot.destinationBaselineSha) {
		throw new PushError(
			"Remote destination changed after push-only validation; refusing stale push.",
			false,
		);
	}
	return { state: "pending", destination: currentDestination };
}

export interface PushOnlyPublicationResult {
	readonly pushedShas: string[];
	readonly publishedSha: string | null;
	readonly remoteTrackingRefSynchronization: RemoteTrackingRefSynchronization | null;
}

export async function validateAndPushTrackedSnapshot(
	repository: RepositoryInfo,
	snapshot: TrackedPushSnapshot,
	settings: Settings,
	scanner?: SecretScanner,
): Promise<PushOnlyPublicationResult> {
	if (!settings.autoPush) {
		return {
			pushedShas: [],
			publishedSha: null,
			remoteTrackingRefSynchronization: null,
		};
	}
	if (!settings.skipTests) await runTestCascade(repository.path);

	assertOutgoingCommitsMatch(repository.path, snapshot, "Push-only");
	const patches = readCommitPatches(repository.path, snapshot.outgoingShas);
	await validateDiffForSecrets(repository, patches, scanner);
	let pushEndpoint: ResolvedPushEndpoint;
	try {
		pushEndpoint = resolveSinglePushEndpoint(repository.path, snapshot.remote);
	} catch (error) {
		const message = sanitizePushDiagnostic(
			error instanceof Error ? error.message : String(error),
		);
		throw new PushError(
			`Cannot resolve push-only destination: ${message}`,
			false,
		);
	}
	if (pushEndpoint.fingerprint !== snapshot.pushUrlFingerprint) {
		throw new PushError(
			"Tracked remote push URL changed after push-only validation.",
			false,
		);
	}
	const revalidated = revalidateTrackedPushSnapshot(
		repository.path,
		snapshot,
		pushEndpoint,
	);
	if (revalidated.state === "already-pushed") {
		const remoteTrackingRefSynchronization =
			synchronizeVerifiedRemoteTrackingRef(
				repository.path,
				revalidated.destination.localTrackingRef,
				snapshot.remote,
				pushEndpoint.fingerprint,
				snapshot.validatedHeadSha,
			);
		return {
			pushedShas: [...snapshot.outgoingShas],
			publishedSha: snapshot.validatedHeadSha,
			remoteTrackingRefSynchronization,
		};
	}

	let pushError: PushError | null = null;
	try {
		pushEndpoint.pushExact(
			snapshot.validatedHeadSha,
			snapshot.destinationRef,
			snapshot.destinationBaselineSha,
		);
	} catch (error) {
		const rawMessage = error instanceof Error ? error.message : String(error);
		pushError = new PushError(
			`Push-only publication failed: ${sanitizePushDiagnostic(rawMessage)}`,
			classifyTransient(rawMessage),
		);
	}

	const observedDestinationSha = pushError
		? resolveUncertainPushOnlyPublication(pushEndpoint, snapshot, pushError)
		: readRemoteDestinationSha(pushEndpoint, snapshot);
	if (observedDestinationSha !== snapshot.validatedHeadSha) {
		throw new PushError(
			"Push completed without updating the destination to the validated HEAD.",
			false,
		);
	}
	const remoteTrackingRefSynchronization = synchronizeVerifiedRemoteTrackingRef(
		repository.path,
		revalidated.destination.localTrackingRef,
		snapshot.remote,
		pushEndpoint.fingerprint,
		snapshot.validatedHeadSha,
	);
	return {
		pushedShas: [...snapshot.outgoingShas],
		publishedSha: snapshot.validatedHeadSha,
		remoteTrackingRefSynchronization,
	};
}
