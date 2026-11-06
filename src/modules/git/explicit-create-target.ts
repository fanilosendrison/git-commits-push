import type { InvocationScope } from "../../types.ts";
import { PushError } from "../core/errors.ts";
import { assertCreationAncestry } from "./creation-local-objects.ts";
import type { ExplicitCreateTargetSnapshot } from "./creation-types.ts";
import {
	openFrozenExplicitEndpoint,
	readExplicitDestinationSha,
	readHeadSha,
} from "./explicit-push-target.ts";
import { resolveSinglePushEndpoint } from "./push-endpoint.ts";

/** Freeze absence and the source anchor at the single effective push endpoint. */
export function captureExplicitCreateTarget(
	scope: Extract<InvocationScope, { kind: "targeted-create" }>,
): ExplicitCreateTargetSnapshot {
	const endpoint = resolveSinglePushEndpoint(
		scope.repository,
		scope.pushRemote,
	);
	const observedBaseRefSha = readExplicitDestinationSha(
		endpoint,
		scope.baseRef,
	);
	if (!observedBaseRefSha)
		throw new PushError(
			"Creation prerequisite missing: source branch is not observable on the push endpoint.",
			false,
		);
	const initialHeadSha = readHeadSha(scope.repository);
	assertCreationAncestry(scope.repository, scope.baseSha, observedBaseRefSha);
	assertCreationAncestry(scope.repository, scope.baseSha, initialHeadSha);
	if (readExplicitDestinationSha(endpoint, scope.pushRef) !== null)
		throw new PushError(
			"Conditional creation requires an absent destination; destination already exists.",
			false,
		);
	return Object.freeze({
		kind: "explicit-create-target",
		remote: scope.pushRemote,
		destinationRef: scope.pushRef,
		baseRef: scope.baseRef,
		baseSha: scope.baseSha,
		observedBaseRefSha,
		initialHeadSha,
		pushUrlFingerprint: endpoint.fingerprint,
	});
}

/** Detect a new destination or changed HEAD before the first commit, preserving work. */
export function assertExplicitCreateTargetCurrent(
	repository: string,
	snapshot: ExplicitCreateTargetSnapshot,
): void {
	if (readHeadSha(repository) !== snapshot.initialHeadSha)
		throw new PushError(
			"Creation HEAD changed after admission; interrupted commits cannot be replanned or rebound.",
			false,
		);
	assertCreationAncestry(
		repository,
		snapshot.baseSha,
		snapshot.observedBaseRefSha,
	);
	assertCreationAncestry(repository, snapshot.baseSha, snapshot.initialHeadSha);
	const endpoint = openFrozenExplicitEndpoint(repository, snapshot);
	if (readExplicitDestinationSha(endpoint, snapshot.destinationRef) !== null)
		throw new PushError(
			"Conditional creation destination appeared before the first commit.",
			false,
		);
}
