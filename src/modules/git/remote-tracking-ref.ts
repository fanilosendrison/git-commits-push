import type { RemoteTrackingRefSynchronization } from "../../types.ts";
import { gitExecArgs } from "./git-exec.ts";
import type { LocalTrackingRefCandidate } from "./push-destination.ts";
import { resolveSingleFetchEndpointFingerprint } from "./push-endpoint.ts";

function readTrackingSha(repository: string, ref: string): string | null {
	try {
		return gitExecArgs(["rev-parse", "--verify", ref], repository) || null;
	} catch {
		return null;
	}
}

/**
 * Synchronize the local projection of an exact, postflight-verified publication.
 * A compare-and-swap protects concurrent fetches, and distinct fetch/push
 * endpoints remain intentionally independent. Local projection failure never
 * changes the already-verified remote publication outcome, so this function
 * reports an outcome instead of throwing.
 */
export function synchronizeVerifiedRemoteTrackingRef(
	repository: string,
	candidate: LocalTrackingRefCandidate | null,
	remote: string,
	pushEndpointFingerprint: string,
	publishedSha: string,
): RemoteTrackingRefSynchronization {
	if (!candidate) return "not-applicable";
	try {
		const fetchEndpointFingerprint = resolveSingleFetchEndpointFingerprint(
			repository,
			remote,
		);
		if (fetchEndpointFingerprint !== pushEndpointFingerprint) {
			return "not-applicable";
		}

		const currentSha = readTrackingSha(repository, candidate.ref);
		if (currentSha === publishedSha) return "already-current";
		if (currentSha !== candidate.expectedSha) {
			return "concurrent-update-preserved";
		}

		try {
			gitExecArgs(
				[
					"update-ref",
					candidate.ref,
					publishedSha,
					candidate.expectedSha ?? "",
				],
				repository,
			);
			return "synchronized";
		} catch {
			const afterFailureSha = readTrackingSha(repository, candidate.ref);
			if (afterFailureSha === publishedSha) return "already-current";
			if (afterFailureSha !== candidate.expectedSha) {
				return "concurrent-update-preserved";
			}
			return "failed";
		}
	} catch {
		return "failed";
	}
}
