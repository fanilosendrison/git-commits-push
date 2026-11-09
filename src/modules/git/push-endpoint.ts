import { createHash, randomUUID } from "node:crypto";
import {
	type GitExecutionPolicy,
	type GitProcessConfigEntry,
	gitExecArgs,
	gitExecArgsRaw,
	PREPARED_MERGE_PROCESS_CONFIGURATION,
} from "./git-exec.ts";
import { parseRemoteRefObservation } from "./git-object-id.ts";

export interface ResolvedPushEndpoint {
	readonly fingerprint: string;
	readDestinationSha(destinationRef: string): string;
	readOptionalDestinationSha(destinationRef: string): string | null;
	pushExact(
		sourceSha: string,
		destinationRef: string,
		destinationBaselineSha: string | null,
	): void;
}

function splitNonemptyLines(value: string): string[] {
	return value
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function fingerprintEndpoint(
	url: string,
	rewriteConfiguration: string,
): string {
	return createHash("sha256")
		.update(url)
		.update("\0")
		.update(rewriteConfiguration)
		.digest("hex");
}

function readUrlRewriteConfiguration(repoPath: string): string {
	try {
		return gitExecArgs(
			[
				"config",
				"--null",
				"--get-regexp",
				"^url\\..*\\.(insteadof|pushinsteadof)$",
			],
			repoPath,
		);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"status" in error &&
			error.status === 1
		) {
			return "";
		}
		throw error;
	}
}

/**
 * Fingerprint one effective fetch URL without exposing it to callers.
 * Any unreadable or ambiguous configuration returns null instead of throwing,
 * because this result only decides whether a local projection is applicable.
 */
export function resolveSingleFetchEndpointFingerprint(
	repoPath: string,
	remote: string,
): string | null {
	try {
		const fetchUrls = splitNonemptyLines(
			gitExecArgs(["remote", "get-url", "--all", "--", remote], repoPath),
		);
		if (fetchUrls.length !== 1) return null;
		const fetchUrl = fetchUrls[0];
		if (!fetchUrl || /[=\0\r\n]/u.test(fetchUrl)) return null;
		return fingerprintEndpoint(fetchUrl, readUrlRewriteConfiguration(repoPath));
	} catch {
		return null;
	}
}

/** Resolve one effective push URL without exposing it to callers or Git argv. */
export function resolveSinglePushEndpoint(
	repoPath: string,
	remote: string,
	executionPolicy: GitExecutionPolicy = "inherit",
): ResolvedPushEndpoint {
	const pushUrls = splitNonemptyLines(
		gitExecArgs(
			["remote", "get-url", "--push", "--all", "--", remote],
			repoPath,
		),
	);
	if (pushUrls.length !== 1) {
		throw new Error(
			`Remote ${remote} must resolve to exactly one push URL; found ${pushUrls.length}.`,
		);
	}
	const pushUrl = pushUrls[0];
	if (!pushUrl) {
		throw new Error(`Remote ${remote} has no push URL.`);
	}
	if (/[=\0\r\n]/u.test(pushUrl)) {
		throw new Error(
			`Remote ${remote} uses a push URL that cannot be safely pinned in process-scoped Git configuration.`,
		);
	}
	const fingerprint = fingerprintEndpoint(
		pushUrl,
		readUrlRewriteConfiguration(repoPath),
	);
	const endpointId = randomUUID();
	const ephemeralRemote = `gcp-endpoint-${endpointId}`;
	const endpointAlias = `gcp-pinned-${endpointId}://endpoint`;
	const processConfig: readonly GitProcessConfigEntry[] = [
		...(executionPolicy === "prepared-merge"
			? PREPARED_MERGE_PROCESS_CONFIGURATION
			: []),
		{ key: `remote.${ephemeralRemote}.url`, value: endpointAlias },
		{ key: `remote.${ephemeralRemote}.pushurl`, value: endpointAlias },
		// Git applies URL rewrites once. A unique alias therefore resolves to the
		// captured URL without letting ambient rules rewrite that URL again.
		{ key: `url.${pushUrl}.insteadOf`, value: endpointAlias },
	];

	function readOptionalDestinationSha(destinationRef: string): string | null {
		const result = gitExecArgsRaw(
			["ls-remote", "--", ephemeralRemote, destinationRef],
			repoPath,
			processConfig,
		);
		return parseRemoteRefObservation(result, destinationRef);
	}

	return {
		fingerprint,
		readDestinationSha(destinationRef: string): string {
			const sha = readOptionalDestinationSha(destinationRef);
			if (!sha) throw new Error("Push destination returned no object ID.");
			return sha;
		},
		readOptionalDestinationSha,
		pushExact(
			sourceSha: string,
			destinationRef: string,
			destinationBaselineSha: string | null,
		): void {
			gitExecArgs(
				[
					"push",
					"--no-follow-tags",
					"--recurse-submodules=no",
					`--force-with-lease=${destinationRef}:${destinationBaselineSha ?? ""}`,
					"--",
					ephemeralRemote,
					`${sourceSha}:${destinationRef}`,
				],
				repoPath,
				processConfig,
			);
		},
	};
}
