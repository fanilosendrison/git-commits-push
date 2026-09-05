import type {
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
import { classifyTransient } from "./push.ts";
import { resolveTrackedPushDestination } from "./push-destination.ts";
import { sanitizePushDiagnostic } from "./push-diagnostic-sanitizer.ts";
import {
	type ResolvedPushEndpoint,
	resolveSinglePushEndpoint,
} from "./push-endpoint.ts";

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

function splitNonemptyLines(value: string): string[] {
	return value
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function isAncestor(
	repoPath: string,
	possibleAncestor: string,
	possibleDescendant: string,
): boolean {
	try {
		gitExecArgs(
			["merge-base", "--is-ancestor", possibleAncestor, possibleDescendant],
			repoPath,
		);
		return true;
	} catch {
		return false;
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
	const outgoingShas = splitNonemptyLines(
		gitExecArgs(
			[
				"rev-list",
				"--reverse",
				`${destinationBaselineSha}..${validatedHeadSha}`,
			],
			repoPath,
		),
	);
	if (outgoingShas.length === 0) return null;

	return {
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

function assertOutgoingShasMatchSnapshot(
	repoPath: string,
	snapshot: TrackedPushSnapshot,
): void {
	try {
		gitExecArgs(
			[
				"merge-base",
				"--is-ancestor",
				snapshot.destinationBaselineSha,
				snapshot.validatedHeadSha,
			],
			repoPath,
		);
	} catch {
		throw new PushError(
			"Push-only baseline is not an ancestor of the validated HEAD.",
			false,
		);
	}
	const currentOutgoingShas = splitNonemptyLines(
		gitExecArgs(
			[
				"rev-list",
				"--reverse",
				`${snapshot.destinationBaselineSha}..${snapshot.validatedHeadSha}`,
			],
			repoPath,
		),
	);
	if (
		currentOutgoingShas.length !== snapshot.outgoingShas.length ||
		currentOutgoingShas.some(
			(sha, index) => sha !== snapshot.outgoingShas[index],
		)
	) {
		throw new PushError(
			"Push-only outgoing commit list no longer matches the validated snapshot.",
			false,
		);
	}
}

function readCommitPatches(
	repoPath: string,
	outgoingShas: readonly string[],
): string {
	return outgoingShas
		.map((sha) =>
			gitExecArgs(
				["show", "--format=", "--binary", "--no-ext-diff", sha],
				repoPath,
			),
		)
		.join("\n");
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

function revalidateTrackedPushSnapshot(
	repoPath: string,
	snapshot: TrackedPushSnapshot,
	pushEndpoint: ResolvedPushEndpoint,
): "pending" | "already-pushed" {
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
		return "already-pushed";
	}
	if (remoteDestinationSha !== snapshot.destinationBaselineSha) {
		throw new PushError(
			"Remote destination changed after push-only validation; refusing stale push.",
			false,
		);
	}
	return "pending";
}

export async function validateAndPushTrackedSnapshot(
	repository: RepositoryInfo,
	snapshot: TrackedPushSnapshot,
	settings: Settings,
	scanner?: SecretScanner,
): Promise<string[]> {
	if (!settings.autoPush) return [];
	if (!settings.skipTests) await runTestCascade(repository.path);

	assertOutgoingShasMatchSnapshot(repository.path, snapshot);
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
	if (
		revalidateTrackedPushSnapshot(repository.path, snapshot, pushEndpoint) ===
		"already-pushed"
	) {
		return [...snapshot.outgoingShas];
	}

	try {
		pushEndpoint.pushExact(
			snapshot.validatedHeadSha,
			snapshot.destinationRef,
			snapshot.destinationBaselineSha,
		);
	} catch (error) {
		const rawMessage = error instanceof Error ? error.message : String(error);
		const message = sanitizePushDiagnostic(rawMessage);
		throw new PushError(
			`Push-only publication failed: ${message}`,
			classifyTransient(rawMessage),
		);
	}

	if (
		readRemoteDestinationSha(pushEndpoint, snapshot) !==
		snapshot.validatedHeadSha
	) {
		throw new PushError(
			"Push completed without updating the destination to the validated HEAD.",
			false,
		);
	}
	return [...snapshot.outgoingShas];
}
