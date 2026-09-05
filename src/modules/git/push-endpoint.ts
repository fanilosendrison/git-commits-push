import { createHash, randomUUID } from "node:crypto";
import { type GitProcessConfigEntry, gitExecArgs } from "./git-exec.ts";

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

/** Resolve one effective push URL without exposing it to callers or Git argv. */
export function resolveSinglePushEndpoint(
	repoPath: string,
	remote: string,
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
	const fingerprint = createHash("sha256")
		.update(pushUrl)
		.update("\0")
		.update(readUrlRewriteConfiguration(repoPath))
		.digest("hex");
	const endpointId = randomUUID();
	const ephemeralRemote = `gcp-endpoint-${endpointId}`;
	const endpointAlias = `gcp-pinned-${endpointId}://endpoint`;
	const processConfig: readonly GitProcessConfigEntry[] = [
		{ key: `remote.${ephemeralRemote}.url`, value: endpointAlias },
		{ key: `remote.${ephemeralRemote}.pushurl`, value: endpointAlias },
		// Git applies URL rewrites once. A unique alias therefore resolves to the
		// captured URL without letting ambient rules rewrite that URL again.
		{ key: `url.${pushUrl}.insteadOf`, value: endpointAlias },
	];

	function readOptionalDestinationSha(destinationRef: string): string | null {
		const result = gitExecArgs(
			["ls-remote", "--", ephemeralRemote, destinationRef],
			repoPath,
			processConfig,
		);
		const sha = result.split(/\s+/u)[0];
		return sha || null;
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
