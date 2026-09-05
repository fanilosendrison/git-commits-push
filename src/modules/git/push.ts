import { PushError } from "../core/errors.ts";
import { gitExecArgs } from "./git-exec.ts";
import { resolveCurrentPushDestination } from "./push-destination.ts";
import { sanitizePushDiagnostic } from "./push-diagnostic-sanitizer.ts";
import {
	type ResolvedPushEndpoint,
	resolveSinglePushEndpoint,
} from "./push-endpoint.ts";

const PERMANENT_PUSH_SIGNATURES: readonly string[] = [
	"Permission denied",
	"Authentication failed",
	"could not read Username",
	"repository not found",
	"access denied",
	"does not appear to be a git repository",
	"not authorized",
	"403",
	"401",
	"GH006",
	"protected branch",
	"protected branch hook declined",
];

export function classifyTransient(message: string): boolean {
	const normalizedMessage = message.toLowerCase();
	return !PERMANENT_PUSH_SIGNATURES.some((signature) =>
		normalizedMessage.includes(signature.toLowerCase()),
	);
}

function createPushError(
	prefix: string,
	error: unknown,
	retryCount = 0,
): PushError {
	const rawMessage = error instanceof Error ? error.message : String(error);
	return new PushError(
		`${prefix}: ${sanitizePushDiagnostic(rawMessage)}`,
		classifyTransient(rawMessage),
		retryCount,
	);
}

function readDestinationSha(
	pushEndpoint: ResolvedPushEndpoint,
	destinationRef: string,
	phase: "preflight" | "recovery check" | "postflight",
	retryCount = 0,
): string | null {
	try {
		return pushEndpoint.readOptionalDestinationSha(destinationRef);
	} catch (error) {
		throw createPushError(`Push ${phase} failed`, error, retryCount);
	}
}

function assertUnchangedOrPublished(
	observedSha: string | null,
	destinationBaselineSha: string | null,
	sourceSha: string,
	retryCount: number,
): boolean {
	if (observedSha === sourceSha) return true;
	if (observedSha === destinationBaselineSha) return false;
	throw new PushError(
		"Push destination changed while recovering an uncertain publication; refusing automatic retry.",
		false,
		retryCount,
	);
}

export function publishWithFrozenEndpoint(
	pushEndpoint: ResolvedPushEndpoint,
	destinationRef: string,
	destinationBaselineSha: string | null,
	sourceSha: string,
): number {
	try {
		pushEndpoint.pushExact(sourceSha, destinationRef, destinationBaselineSha);
		return 0;
	} catch (error) {
		const firstError = createPushError("Push publication failed", error);
		if (!firstError.transient) throw firstError;
	}

	const retryCount = 1;
	const observedSha = readDestinationSha(
		pushEndpoint,
		destinationRef,
		"recovery check",
		retryCount,
	);
	if (
		assertUnchangedOrPublished(
			observedSha,
			destinationBaselineSha,
			sourceSha,
			retryCount,
		)
	) {
		return retryCount;
	}

	try {
		pushEndpoint.pushExact(sourceSha, destinationRef, destinationBaselineSha);
	} catch (error) {
		const finalError = createPushError(
			"Push publication retry failed",
			error,
			retryCount,
		);
		const finalObservedSha = readDestinationSha(
			pushEndpoint,
			destinationRef,
			"recovery check",
			retryCount,
		);
		if (
			assertUnchangedOrPublished(
				finalObservedSha,
				destinationBaselineSha,
				sourceSha,
				retryCount,
			)
		) {
			return retryCount;
		}
		throw finalError;
	}
	return retryCount;
}

function assertFastForwardPublication(
	repository: string,
	destinationBaselineSha: string | null,
	sourceSha: string,
): void {
	if (!destinationBaselineSha || destinationBaselineSha === sourceSha) return;
	try {
		gitExecArgs(
			["merge-base", "--is-ancestor", destinationBaselineSha, sourceSha],
			repository,
		);
	} catch {
		throw new PushError(
			"Remote destination is not an ancestor of the exact source commit; refusing automatic push.",
			false,
		);
	}
}

function establishUpstreamTracking(
	repository: string,
	sourceBranch: string,
	remote: string,
	destinationRef: string,
	sourceSha: string,
): void {
	try {
		gitExecArgs(
			["config", `branch.${sourceBranch}.remote`, remote],
			repository,
		);
		gitExecArgs(
			["config", `branch.${sourceBranch}.merge`, destinationRef],
			repository,
		);
		const upstreamRef = gitExecArgs(
			[
				"for-each-ref",
				"--format=%(upstream)",
				"--",
				`refs/heads/${sourceBranch}`,
			],
			repository,
		);
		if (!upstreamRef.startsWith("refs/remotes/")) {
			throw new Error("Git did not resolve a remote-tracking upstream ref.");
		}
		gitExecArgs(["update-ref", upstreamRef, sourceSha], repository);
	} catch (error) {
		const rawMessage = error instanceof Error ? error.message : String(error);
		throw new PushError(
			`Push succeeded but upstream tracking could not be established: ${sanitizePushDiagnostic(rawMessage)}`,
			false,
		);
	}
}

/** Publish the exact current HEAD to one resolved endpoint with a remote lease. */
export function executePush(repository: string, autoPush: boolean): number {
	if (!autoPush) return 0;

	let destination: ReturnType<typeof resolveCurrentPushDestination>;
	try {
		destination = resolveCurrentPushDestination(repository);
	} catch (error) {
		const rawMessage = error instanceof Error ? error.message : String(error);
		throw new PushError(
			`Cannot resolve push destination: ${sanitizePushDiagnostic(rawMessage)}`,
			false,
		);
	}
	if (!destination) return 0;

	let pushEndpoint: ResolvedPushEndpoint;
	try {
		pushEndpoint = resolveSinglePushEndpoint(repository, destination.remote);
	} catch (error) {
		const rawMessage = error instanceof Error ? error.message : String(error);
		throw new PushError(
			`Cannot resolve push endpoint: ${sanitizePushDiagnostic(rawMessage)}`,
			false,
		);
	}

	let sourceSha: string;
	try {
		sourceSha = gitExecArgs(["rev-parse", "HEAD"], repository);
	} catch (error) {
		const rawMessage = error instanceof Error ? error.message : String(error);
		throw new PushError(
			`Cannot resolve exact source commit: ${sanitizePushDiagnostic(rawMessage)}`,
			false,
		);
	}
	const destinationBaselineSha = readDestinationSha(
		pushEndpoint,
		destination.destinationRef,
		"preflight",
	);
	assertFastForwardPublication(repository, destinationBaselineSha, sourceSha);

	let retryCount = 0;
	if (destinationBaselineSha !== sourceSha) {
		retryCount = publishWithFrozenEndpoint(
			pushEndpoint,
			destination.destinationRef,
			destinationBaselineSha,
			sourceSha,
		);
	}

	let destinationSha: string | null;
	try {
		destinationSha = readDestinationSha(
			pushEndpoint,
			destination.destinationRef,
			"postflight",
			retryCount,
		);
	} catch (error) {
		if (!(error instanceof PushError) || !error.transient || retryCount > 0) {
			throw error;
		}
		retryCount = 1;
		destinationSha = readDestinationSha(
			pushEndpoint,
			destination.destinationRef,
			"postflight",
			retryCount,
		);
	}
	if (destinationSha !== sourceSha) {
		throw new PushError(
			"Push completed without updating the destination to the exact source commit.",
			false,
			retryCount,
		);
	}

	if (destination.establishUpstream) {
		establishUpstreamTracking(
			repository,
			destination.sourceBranch,
			destination.remote,
			destination.destinationRef,
			sourceSha,
		);
	}
	return retryCount;
}
