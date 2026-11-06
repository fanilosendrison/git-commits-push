import assert from "node:assert/strict";
import { test } from "node:test";
import { stateSchema } from "../../src/config/state-schema.ts";
import { stateSchema as baselineSchema } from "../fixtures/baseline-state-reader/src/config/state-schema.ts";

const B = "a".repeat(40),
	R = "b".repeat(40),
	S = "c".repeat(40);
const scope = {
	kind: "targeted-create",
	repository: "/isolated/worktree",
	pushRemote: "origin",
	pushRef: "refs/heads/task",
	baseRef: "refs/heads/source",
	baseSha: B,
};
const common = {
	remote: "origin",
	destinationRef: scope.pushRef,
	baseRef: scope.baseRef,
	baseSha: B,
	observedBaseRefSha: R,
	pushUrlFingerprint: "d".repeat(64),
};
const push = {
	kind: "explicit-create",
	...common,
	validatedHeadSha: S,
	outgoingShas: [S],
};
const target = { kind: "explicit-create-target", ...common, initialHeadSha: B };
const successful = {
	repository: scope.repository,
	status: "SUCCESS",
	operation: "push-only",
	pushSnapshot: push,
	pushedShas: [S],
	publishedSha: S,
	remoteTrackingRefSynchronization: "not-applicable",
};
function state(repo: unknown, invocationScope: unknown = scope) {
	return { invocationScope, repos: { task: repo } };
}

test("C26 C27 | new state requires exact creation authority; real baseline reader refuses it", () => {
	assert.equal(stateSchema.safeParse(state(successful)).success, true);
	assert.equal(baselineSchema.safeParse(state(successful)).success, false);
	assert.equal(
		baselineSchema.safeParse({ invocationScope: scope, repos: {} }).success,
		false,
	);
	for (const legacy of [
		{ kind: "global" },
		{ kind: "worktree", repository: scope.repository },
		{
			kind: "targeted",
			repository: scope.repository,
			pushRemote: "origin",
			pushRef: scope.pushRef,
		},
	]) {
		assert.equal(
			stateSchema.safeParse(state(successful, legacy)).success,
			false,
		);
		assert.equal(
			stateSchema.safeParse(state(successful, { ...legacy, baseSha: B }))
				.success,
			false,
		);
	}
	for (const mutation of [
		{ baseSha: R },
		{ baseRef: scope.pushRef },
		{ pushRemote: "other" },
		{ repository: "/other" },
		{ baseSha: null },
		{ baseSha: "0".repeat(40) },
		{ injected: true },
	])
		assert.equal(
			stateSchema.safeParse(state(successful, { ...scope, ...mutation }))
				.success,
			false,
		);
	for (const mutation of [
		{ baseSha: R },
		{ destinationRef: "refs/heads/other" },
		{ remote: "other" },
		{ observedBaseRefSha: null },
		{ baseRef: "refs/tags/base" },
		{ outgoingShas: [] },
		{ outgoingShas: [S, S] },
		{ outgoingShas: [B, S] },
		{ validatedHeadSha: B },
		{ destinationBaselineSha: B },
	])
		assert.equal(
			stateSchema.safeParse(
				state({ ...successful, pushSnapshot: { ...push, ...mutation } }),
			).success,
			false,
		);
});

test("C12 C35 | only at-base creation permits empty outgoing; success needs exact final publication", () => {
	const atBase = {
		...successful,
		pushSnapshot: { ...push, validatedHeadSha: B, outgoingShas: [] },
		pushedShas: [],
		publishedSha: B,
	};
	assert.equal(stateSchema.safeParse(state(atBase)).success, true);
	for (const mutation of [
		{ publishedSha: undefined },
		{ publishedSha: B },
		{ pushedShas: [] },
		{ remoteTrackingRefSynchronization: "synchronized" },
		{ pushSnapshot: undefined },
	])
		assert.equal(
			stateSchema.safeParse(state({ ...successful, ...mutation })).success,
			false,
		);
	const dirty = {
		repository: scope.repository,
		status: "SUCCESS",
		operation: "commit-and-push",
		explicitPushTargetSnapshot: target,
		committedShas: [{ sha: S, files: ["file"] }],
		creationPublicationSnapshot: push,
		publishedSha: S,
		remoteTrackingRefSynchronization: "not-applicable",
	};
	assert.equal(stateSchema.safeParse(state(dirty)).success, true);
	assert.equal(
		stateSchema.safeParse(
			state({
				...dirty,
				status: "RUNNING",
				creationPublicationSnapshot: undefined,
			}),
		).success,
		false,
		"publication evidence must be bound even before SUCCESS",
	);
	assert.equal(
		stateSchema.safeParse(
			state({ ...dirty, status: "FAILED", committedShas: [] }),
		).success,
		false,
		"retained final identity must always bind its commits",
	);
	assert.equal(
		stateSchema.safeParse({
			invocationScope: scope,
			repos: { first: dirty, second: dirty },
		}).success,
		false,
		"creation cannot duplicate its exact worktree under multiple IDs",
	);
	for (const mutation of [
		{ creationPublicationSnapshot: undefined },
		{ committedShas: [] },
		{ publishedSha: B },
		{ creationPublicationSnapshot: { ...push, observedBaseRefSha: S } },
		{ explicitPushTargetSnapshot: { ...target, baseSha: R } },
	])
		assert.equal(
			stateSchema.safeParse(state({ ...dirty, ...mutation })).success,
			false,
		);
});

test("C27 | historical tracked/update states keep the actual baseline interpretation", () => {
	const oldScope = {
		kind: "targeted",
		repository: scope.repository,
		pushRemote: "origin",
		pushRef: scope.pushRef,
	};
	const legacyPush = {
		kind: "explicit",
		remote: "origin",
		destinationRef: scope.pushRef,
		pushUrlFingerprint: common.pushUrlFingerprint,
		destinationBaselineSha: B,
		validatedHeadSha: S,
		outgoingShas: [S],
	};
	const oldState = state({ ...successful, pushSnapshot: legacyPush }, oldScope);
	assert.deepEqual(stateSchema.parse(oldState), baselineSchema.parse(oldState));
	const missingScope = { repos: {} };
	assert.deepEqual(
		stateSchema.parse(missingScope),
		baselineSchema.parse(missingScope),
	);
});
