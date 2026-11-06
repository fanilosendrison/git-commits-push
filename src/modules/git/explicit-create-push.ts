import type { Settings } from "../../types.ts";
import { PushError } from "../core/errors.ts";
import { assertCreationAncestry } from "./creation-local-objects.ts";
import type {
	ExplicitCreatePushSnapshot,
	ExplicitCreateTargetSnapshot,
} from "./creation-types.ts";
import { validateAndPushExplicitSnapshot } from "./explicit-push.ts";
import { readHeadSha } from "./explicit-push-target.ts";
import { readOrderedOutgoingShas } from "./outgoing-commits.ts";

/** Freeze all B..S commits; S == B remains real conditional creation work. */
export function buildExplicitCreatePushSnapshot(
	repository: string,
	target: ExplicitCreateTargetSnapshot,
): ExplicitCreatePushSnapshot {
	const validatedHeadSha = readHeadSha(repository);
	assertCreationAncestry(repository, target.baseSha, validatedHeadSha);
	return {
		kind: "explicit-create",
		remote: target.remote,
		destinationRef: target.destinationRef,
		baseRef: target.baseRef,
		baseSha: target.baseSha,
		observedBaseRefSha: target.observedBaseRefSha,
		validatedHeadSha,
		outgoingShas: readOrderedOutgoingShas(
			repository,
			target.baseSha,
			validatedHeadSha,
			true,
		),
		pushUrlFingerprint: target.pushUrlFingerprint,
	};
}

/** Validate the entire final history, then publish through the shared exact transport. */
export async function publishExplicitCreateSnapshot(
	repository: string,
	target: ExplicitCreateTargetSnapshot,
	settings: Settings,
	expectedSourceSha: string,
): Promise<{
	readonly publishedSha: string;
	readonly retryCount: number;
	readonly snapshot: ExplicitCreatePushSnapshot;
}> {
	try {
		const snapshot = buildExplicitCreatePushSnapshot(repository, target);
		if (snapshot.validatedHeadSha !== expectedSourceSha)
			throw new PushError(
				"Creation HEAD no longer matches the commits produced by this invocation.",
				false,
			);
		const result = await validateAndPushExplicitSnapshot(
			{ id: "creation", path: repository },
			snapshot,
			settings,
		);
		return {
			publishedSha: result.publishedSha,
			retryCount: result.retryCount,
			snapshot,
		};
	} catch (error) {
		if (error instanceof PushError) throw error;
		// Ensure post-commit validation failures preserve landed commit evidence too.
		throw new PushError(
			error instanceof Error ? error.message : String(error),
			false,
		);
	}
}
