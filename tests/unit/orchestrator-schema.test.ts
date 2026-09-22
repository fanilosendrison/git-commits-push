import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stateSchema } from "../../src/config/state-schema.ts";

const REPO_PATH = "/path/to/repo";
const FINGERPRINT = "a".repeat(64);
const BASELINE = "b".repeat(40);
const HEAD = "c".repeat(40);
const SECOND = "d".repeat(40);
const TARGETED_SCOPE = {
	kind: "targeted",
	repository: REPO_PATH,
	pushRemote: "origin",
	pushRef: "refs/heads/main",
};

/** Current-shape tracked snapshot; override one field to build a broken variant. */
function trackedSnapshot(overrides: Record<string, unknown> = {}) {
	return {
		kind: "tracked",
		sourceBranch: "main",
		validatedHeadSha: HEAD,
		upstreamRef: "origin/main",
		remote: "origin",
		destinationRef: "refs/heads/main",
		destinationBaselineSha: BASELINE,
		outgoingShas: [HEAD],
		pushUrlFingerprint: FINGERPRINT,
		...overrides,
	};
}
/** Pre-#7 tracked snapshot: no discriminant, never reinterpreted as explicit. */
function legacyTrackedSnapshot() {
	const { kind: _kind, ...rest } = trackedSnapshot();
	return rest;
}
function explicitSnapshot(overrides: Record<string, unknown> = {}) {
	return {
		kind: "explicit",
		validatedHeadSha: HEAD,
		remote: "origin",
		destinationRef: "refs/heads/main",
		destinationBaselineSha: BASELINE,
		outgoingShas: [HEAD],
		pushUrlFingerprint: FINGERPRINT,
		...overrides,
	};
}
function frozenTarget(overrides: Record<string, unknown> = {}) {
	return {
		remote: "origin",
		destinationRef: "refs/heads/main",
		destinationBaselineSha: BASELINE,
		pushUrlFingerprint: FINGERPRINT,
		...overrides,
	};
}
function parseStateWithRepo(repo: Record<string, unknown>) {
	return stateSchema.safeParse({ repos: { "repo-1": repo } });
}
/** One repo state under global discovery, with the given fields. */
function repoState(extra: Record<string, unknown>) {
	return parseStateWithRepo({ repository: REPO_PATH, ...extra });
}
/** One push-only repo state carrying the given snapshot. */
function pushOnlyState(snapshot: unknown, extra: Record<string, unknown> = {}) {
	return repoState({
		status: "RUNNING",
		operation: "push-only",
		pushSnapshot: snapshot,
		...extra,
	});
}
/** One repo state under the targeted scope, with the given fields. */
function targetedState(extra: Record<string, unknown>) {
	return stateSchema.safeParse({
		invocationScope: TARGETED_SCOPE,
		repos: {
			"repo-1": { repository: REPO_PATH, status: "RUNNING", ...extra },
		},
	});
}
/** A targeted commit-and-push carrying the given frozen explicit target. */
function targetedCommit(frozen: unknown) {
	return targetedState({
		operation: "commit-and-push",
		explicitPushTargetSnapshot: frozen,
	});
}
/** Every listed parse result must fail closed. */
function assertRejected(results: ReadonlyArray<{ success: boolean }>): void {
	for (const result of results) {
		assert.strictEqual(result.success, false);
	}
}

describe("production state schema", () => {
	test("accepts a minimal state and rejects an unknown status", () => {
		assert.strictEqual(
			parseStateWithRepo({ repository: REPO_PATH, status: "PENDING" }).success,
			true,
		);
		assert.strictEqual(
			parseStateWithRepo({ repository: REPO_PATH, status: "INVALID" }).success,
			false,
		);
	});

	test("round-trips the complete push-only state without a raw endpoint", () => {
		const input = {
			invocationScope: { kind: "global" },
			repos: {
				"repo-1": {
					repository: REPO_PATH,
					status: "SUCCESS",
					operation: "push-only",
					pushSnapshot: trackedSnapshot({ outgoingShas: [SECOND, HEAD] }),
					pushedShas: [SECOND, HEAD],
					publishedSha: HEAD,
					remoteTrackingRefSynchronization: "synchronized",
				},
			},
		};
		const result = stateSchema.safeParse(input);

		assert.strictEqual(result.success, true);
		if (!result.success) return;
		assert.deepStrictEqual(result.data, input);
		assert.ok(!JSON.stringify(result.data).includes("https://"));
	});

	test("rejects invalid or inconsistent publication evidence", () => {
		const withoutFingerprint = trackedSnapshot();
		delete (withoutFingerprint as Record<string, unknown>).pushUrlFingerprint;
		assertRejected([
			repoState({
				status: "SUCCESS",
				remoteTrackingRefSynchronization: "synchronized",
			}),
			repoState({
				status: "SUCCESS",
				publishedSha: HEAD,
				remoteTrackingRefSynchronization: "invented",
			}),
			pushOnlyState(withoutFingerprint),
			pushOnlyState(trackedSnapshot({ outgoingShas: [] })),
			pushOnlyState(trackedSnapshot({ outgoingShas: ["abc123"] })),
			pushOnlyState(trackedSnapshot(), { pushedShas: ["not-a-sha"] }),
			pushOnlyState(trackedSnapshot({ outgoingShas: [SECOND, HEAD] }), {
				status: "SUCCESS",
				pushedShas: [HEAD],
			}),
			pushOnlyState(trackedSnapshot(), {
				status: "SUCCESS",
				pushedShas: [HEAD],
				publishedSha: SECOND,
			}),
			repoState({
				status: "SUCCESS",
				operation: "push-only",
				pushedShas: [HEAD],
			}),
			repoState({
				status: "SUCCESS",
				operation: "commit-and-push",
				pushedShas: ["not-a-sha"],
			}),
		]);
	});

	test("accepts the complete commit-and-push state", () => {
		const result = repoState({
			status: "RUNNING",
			operation: "commit-and-push",
			diffHash: "abc123",
			commits: [
				{
					commit: {
						type: "feat",
						description: "add feature",
						isBreaking: false,
					},
					files: ["src/index.ts"],
				},
			],
			error: "something failed",
			attempts: { structural: 1, git: 0, validation: 0, race: 0, network: 0 },
			committedShas: [{ sha: "abc123", files: ["src/index.ts"] }],
			originalHead: "def456",
			feedbackHistory: ["plan1", "plan2"],
			lastPlanHash: "sha256hash",
			loopDetected: { kind: "structural", planHash: "sha256hash" },
			fallbackAttempted: true,
		});
		assert.strictEqual(result.success, true);
	});
});

describe("production push snapshot discrimination", () => {
	test("normalizes a legacy tracked snapshot that has no discriminant", () => {
		const result = pushOnlyState(legacyTrackedSnapshot());

		assert.strictEqual(result.success, true);
		if (!result.success) return;
		assert.strictEqual(
			result.data.repos["repo-1"]?.pushSnapshot?.kind,
			"tracked",
		);
	});

	test("accepts an explicit push-only snapshot without tracked-only fields", () => {
		const input = {
			invocationScope: TARGETED_SCOPE,
			repos: {
				"repo-1": {
					repository: REPO_PATH,
					status: "SUCCESS",
					operation: "push-only",
					pushSnapshot: explicitSnapshot(),
					pushedShas: [HEAD],
					publishedSha: HEAD,
					remoteTrackingRefSynchronization: "not-applicable",
				},
			},
		};
		const result = stateSchema.safeParse(input);

		assert.strictEqual(result.success, true);
		if (!result.success) return;
		assert.deepStrictEqual(result.data, input);
	});

	test("accepts a frozen explicit target for a targeted commit-and-push", () => {
		assert.strictEqual(targetedCommit(frozenTarget()).success, true);
	});

	test("rejects every malformed or unauthorized publication state", () => {
		assertRejected([
			// Snapshot shape: missing, unknown, or wrong discriminant.
			pushOnlyState({ validatedHeadSha: HEAD }),
			pushOnlyState(trackedSnapshot({ kind: "invented" })),
			pushOnlyState(explicitSnapshot({ kind: "tracked" })),
			pushOnlyState(explicitSnapshot({ destinationRef: "main" })),
			// Frozen target shape.
			targetedCommit({}),
			targetedCommit(frozenTarget({ destinationRef: "main" })),
			targetedCommit(frozenTarget({ pushUrlFingerprint: "short" })),
			targetedCommit(frozenTarget({ destinationBaselineSha: "abc" })),
			// The destination must match the targeted invocation scope.
			targetedCommit(frozenTarget({ remote: "upstream" })),
			targetedCommit(frozenTarget({ destinationRef: "refs/heads/other" })),
			// A global invocation owns no explicit publication authority.
			repoState({
				status: "RUNNING",
				operation: "commit-and-push",
				explicitPushTargetSnapshot: frozenTarget(),
			}),
			repoState({
				status: "RUNNING",
				operation: "push-only",
				pushSnapshot: explicitSnapshot(),
			}),
			// Targeted identity, required frozen target, exclusive authority.
			targetedState({ operation: "commit-and-push", diffHash: "abc" }),
			targetedState({
				operation: "push-only",
				pushSnapshot: explicitSnapshot(),
				explicitPushTargetSnapshot: frozenTarget(),
			}),
			stateSchema.safeParse({
				invocationScope: TARGETED_SCOPE,
				repos: {
					"repo-1": {
						repository: "/path/to/other",
						status: "RUNNING",
						operation: "commit-and-push",
						explicitPushTargetSnapshot: frozenTarget(),
					},
				},
			}),
		]);
	});

	test("never retains a raw push URL in the persisted projection", () => {
		const result = targetedCommit({
			...frozenTarget(),
			pushUrl: "https://example.invalid/repo.git",
		});

		assert.strictEqual(result.success, true);
		if (!result.success) return;
		const serialized = JSON.stringify(result.data);
		assert.ok(!serialized.includes("https://"));
		assert.ok(!serialized.includes('"pushUrl"'));
	});
});

describe("production invocation scope schema", () => {
	test("normalizes a historical missing invocationScope to global", () => {
		const result = stateSchema.safeParse({ repos: {} });

		assert.strictEqual(result.success, true);
		if (!result.success) return;
		assert.deepStrictEqual(result.data.invocationScope, { kind: "global" });
	});

	test("round-trips explicit global and targeted scopes", () => {
		const global = stateSchema.safeParse({
			invocationScope: { kind: "global" },
			repos: {},
		});
		const targeted = stateSchema.safeParse({
			invocationScope: TARGETED_SCOPE,
			repos: {},
		});

		assert.strictEqual(global.success && targeted.success, true);
		if (!global.success || !targeted.success) return;
		assert.deepStrictEqual(global.data.invocationScope, { kind: "global" });
		assert.deepStrictEqual(targeted.data.invocationScope, TARGETED_SCOPE);
	});

	test("rejects malformed present invocationScope values", () => {
		assertRejected(
			[
				null,
				{ kind: "targeted", pushRemote: "origin", pushRef: "refs/heads/main" },
				{ ...TARGETED_SCOPE, repository: "relative/path" },
				{ ...TARGETED_SCOPE, pushRemote: "" },
				{ ...TARGETED_SCOPE, pushRef: "main" },
				{ ...TARGETED_SCOPE, pushRef: "refs/heads/" },
				{ kind: "unknown" },
			].map((invocationScope) =>
				stateSchema.safeParse({ invocationScope, repos: {} }),
			),
		);
	});
});

describe("production attempts schema compatibility", () => {
	test("accepts every supported attempt kind", () => {
		const attempts = {
			structural: 2,
			validation: 1,
			git: 0,
			race: 0,
			network: 0,
		};
		const result = repoState({ status: "RUNNING", attempts });
		assert.strictEqual(result.success, true);
		if (result.success) {
			assert.deepStrictEqual(result.data.repos["repo-1"]?.attempts, attempts);
		}
	});

	test("normalizes legacy numeric attempts to an empty object", () => {
		const result = repoState({ status: "RUNNING", attempts: 3 });
		assert.strictEqual(result.success, true);
		if (result.success) {
			assert.deepStrictEqual(result.data.repos["repo-1"]?.attempts, {});
		}
	});

	test("rejects invalid attempt keys and values", () => {
		assertRejected(
			[{ validaton: 1 }, { structural: -1 }, { structural: 1.5 }].map(
				(attempts) => repoState({ status: "RUNNING", attempts }),
			),
		);
	});
});

describe("production persisted outcome fields", () => {
	test("accepts committed SHAs and structured loop detection", () => {
		const result = repoState({
			status: "FAILED",
			committedShas: [
				{ sha: "abc", files: ["f1.ts"] },
				{ sha: "def", files: ["f2.ts", "f3.ts"] },
			],
			loopDetected: { kind: "network", planHash: "hash123" },
			feedbackHistory: ["attempt 1", "attempt 2"],
		});
		assert.strictEqual(result.success, true);
	});

	test("rejects malformed committed SHAs and loop kinds", () => {
		assertRejected([
			repoState({
				status: "FAILED",
				committedShas: [{ files: ["f1.ts"] }],
			}),
			repoState({
				status: "FAILED",
				loopDetected: { kind: "unknown", planHash: "hash123" },
			}),
		]);
	});
});
