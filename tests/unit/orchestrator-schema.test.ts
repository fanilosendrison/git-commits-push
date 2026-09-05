import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stateSchema } from "../../src/config/state-schema.ts";

function parseStateWithRepo(repo: Record<string, unknown>) {
	return stateSchema.safeParse({ repos: { "repo-1": repo } });
}

describe("production state schema", () => {
	test("accepts a minimal state", () => {
		const result = parseStateWithRepo({
			repository: "/path/to/repo",
			status: "PENDING",
		});
		assert.strictEqual(result.success, true);
	});

	test("round-trips the complete push-only state without a raw endpoint", () => {
		const input = {
			repos: {
				"repo-1": {
					repository: "/path/to/repo",
					status: "SUCCESS",
					operation: "push-only",
					pushSnapshot: {
						sourceBranch: "main",
						validatedHeadSha: "c".repeat(40),
						upstreamRef: "origin/main",
						remote: "origin",
						destinationRef: "refs/heads/main",
						destinationBaselineSha: "b".repeat(40),
						outgoingShas: ["d".repeat(40), "c".repeat(40)],
						pushUrlFingerprint: "a".repeat(64),
					},
					pushedShas: ["d".repeat(40), "c".repeat(40)],
				},
			},
		} as const;
		const result = stateSchema.safeParse(input);

		assert.strictEqual(result.success, true);
		if (!result.success) return;
		assert.deepStrictEqual(result.data, input);
		assert.ok(!JSON.stringify(result.data).includes("https://"));
	});

	test("rejects a push snapshot without its endpoint fingerprint", () => {
		const result = parseStateWithRepo({
			repository: "/path/to/repo",
			status: "RUNNING",
			operation: "push-only",
			pushSnapshot: {
				sourceBranch: "main",
				validatedHeadSha: "c".repeat(40),
				upstreamRef: "origin/main",
				remote: "origin",
				destinationRef: "refs/heads/main",
				destinationBaselineSha: "b".repeat(40),
				outgoingShas: ["c".repeat(40)],
			},
		});
		assert.strictEqual(result.success, false);
	});

	test("rejects empty or abbreviated outgoing commit IDs", () => {
		for (const outgoingShas of [[], ["abc123"]]) {
			const result = parseStateWithRepo({
				repository: "/path/to/repo",
				status: "RUNNING",
				operation: "push-only",
				pushSnapshot: {
					sourceBranch: "main",
					validatedHeadSha: "c".repeat(40),
					upstreamRef: "origin/main",
					remote: "origin",
					destinationRef: "refs/heads/main",
					destinationBaselineSha: "b".repeat(40),
					outgoingShas,
					pushUrlFingerprint: "a".repeat(64),
				},
			});
			assert.strictEqual(result.success, false);
		}
	});

	test("rejects inconsistent operation-specific push evidence", () => {
		const pushOnlyWithoutSnapshot = parseStateWithRepo({
			repository: "/path/to/repo",
			status: "SUCCESS",
			operation: "push-only",
			pushedShas: ["c".repeat(40)],
		});
		assert.strictEqual(pushOnlyWithoutSnapshot.success, false);

		const commitWithPushOnlyEvidence = parseStateWithRepo({
			repository: "/path/to/repo",
			status: "SUCCESS",
			operation: "commit-and-push",
			pushedShas: ["not-a-sha"],
		});
		assert.strictEqual(commitWithPushOnlyEvidence.success, false);
	});

	test("rejects malformed pushed object IDs", () => {
		const result = parseStateWithRepo({
			repository: "/path/to/repo",
			status: "SUCCESS",
			operation: "push-only",
			pushSnapshot: {
				sourceBranch: "main",
				validatedHeadSha: "c".repeat(40),
				upstreamRef: "origin/main",
				remote: "origin",
				destinationRef: "refs/heads/main",
				destinationBaselineSha: "b".repeat(40),
				outgoingShas: ["c".repeat(40)],
				pushUrlFingerprint: "a".repeat(64),
			},
			pushedShas: ["not-a-sha"],
		});
		assert.strictEqual(result.success, false);
	});

	test("rejects incomplete successful push-only evidence", () => {
		const result = parseStateWithRepo({
			repository: "/path/to/repo",
			status: "SUCCESS",
			operation: "push-only",
			pushSnapshot: {
				sourceBranch: "main",
				validatedHeadSha: "c".repeat(40),
				upstreamRef: "origin/main",
				remote: "origin",
				destinationRef: "refs/heads/main",
				destinationBaselineSha: "b".repeat(40),
				outgoingShas: ["d".repeat(40), "c".repeat(40)],
				pushUrlFingerprint: "a".repeat(64),
			},
			pushedShas: ["c".repeat(40)],
		});
		assert.strictEqual(result.success, false);
	});

	test("accepts the complete commit-and-push state", () => {
		const result = parseStateWithRepo({
			repository: "/path/to/repo",
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
			attempts: {
				structural: 1,
				git: 0,
				validation: 0,
				race: 0,
				network: 0,
			},
			committedShas: [{ sha: "abc123", files: ["src/index.ts"] }],
			originalHead: "def456",
			feedbackHistory: ["plan1", "plan2"],
			lastPlanHash: "sha256hash",
			loopDetected: { kind: "structural", planHash: "sha256hash" },
			fallbackAttempted: true,
		});
		assert.strictEqual(result.success, true);
	});

	test("rejects an invalid status", () => {
		const result = parseStateWithRepo({
			repository: "/path",
			status: "INVALID",
		});
		assert.strictEqual(result.success, false);
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
		const result = parseStateWithRepo({
			repository: "/path",
			status: "RUNNING",
			attempts,
		});
		assert.strictEqual(result.success, true);
		if (result.success) {
			assert.deepStrictEqual(result.data.repos["repo-1"]?.attempts, attempts);
		}
	});

	test("normalizes legacy numeric attempts to an empty object", () => {
		const result = parseStateWithRepo({
			repository: "/path",
			status: "RUNNING",
			attempts: 3,
		});
		assert.strictEqual(result.success, true);
		if (result.success) {
			assert.deepStrictEqual(result.data.repos["repo-1"]?.attempts, {});
		}
	});

	test("rejects invalid attempt keys and values", () => {
		for (const attempts of [
			{ validaton: 1 },
			{ structural: -1 },
			{ structural: 1.5 },
		]) {
			const result = parseStateWithRepo({
				repository: "/path",
				status: "RUNNING",
				attempts,
			});
			assert.strictEqual(result.success, false);
		}
	});
});

describe("production persisted outcome fields", () => {
	test("accepts committed SHAs and structured loop detection", () => {
		const result = parseStateWithRepo({
			repository: "/path",
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
		assert.strictEqual(
			parseStateWithRepo({
				repository: "/path",
				status: "FAILED",
				committedShas: [{ files: ["f1.ts"] }],
			}).success,
			false,
		);
		assert.strictEqual(
			parseStateWithRepo({
				repository: "/path",
				status: "FAILED",
				loopDetected: { kind: "unknown", planHash: "hash123" },
			}).success,
			false,
		);
	});
});
