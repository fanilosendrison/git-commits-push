/**
 * tests/unit/reporter-v2.test.ts — Tests for Phase 8 reporter update.
 *
 * Plan ref: §8.0 Reporter contract (R39, R62)
 *   - buildReport() maps RepoState[] → RepoReport[]
 *   - generateReport() renders new fields: committedShas, attempts, loopDetected
 *   - totalRetries computed as sum of attempts
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	buildReport,
	generateReport,
} from "../../src/modules/core/reporter.ts";
import type { RepoState } from "../../src/types.ts";

// ── buildReport ──────────────────────────────────────────────────────────────

describe("buildReport", () => {
	test("empty repos → empty array", () => {
		const result = buildReport({});
		assert.deepStrictEqual(result, []);
	});

	test("SUCCESS repo with committedShas and attempts", () => {
		const repos: Record<string, RepoState> = {
			"repo-1": {
				repository: "/path/a",
				status: "SUCCESS",
				committedShas: [{ sha: "abc123", files: ["f1.ts"] }],
				attempts: { structural: 1, validation: 0, race: 0, git: 0, network: 0 },
			},
		};
		const result = buildReport(repos);
		assert.strictEqual(result.length, 1);
		const reportEntry = result[0];
		assert.ok(reportEntry);
		assert.strictEqual(reportEntry.repository, "/path/a");
		assert.strictEqual(reportEntry.status, "SUCCESS");
		assert.strictEqual(reportEntry.committedShas.length, 1);
		assert.strictEqual(reportEntry.committedShas[0]?.sha, "abc123");
		assert.deepStrictEqual(reportEntry.attempts, {
			structural: 1,
			validation: 0,
			race: 0,
			git: 0,
			network: 0,
		});
		assert.strictEqual(result[0]?.totalRetries, 1);
	});

	test("totalRetries sums all attempt kinds", () => {
		const repos: Record<string, RepoState> = {
			"repo-1": {
				repository: "/path",
				status: "SUCCESS",
				attempts: {
					validation: 2,
					structural: 3,
					race: 0,
					git: 1,
					network: 0,
				},
			},
		};
		const result = buildReport(repos);
		assert.strictEqual(result[0]?.totalRetries, 6); // 2+3+0+1+0
	});

	test("FAILED repo with loopDetected", () => {
		const repos: Record<string, RepoState> = {
			"repo-1": {
				repository: "/path",
				status: "FAILED",
				error: "Loop detected",
				loopDetected: { kind: "structural", planHash: "hash123" },
				attempts: { structural: 1, validation: 0, race: 0, git: 0, network: 0 },
			},
		};
		const result = buildReport(repos);
		assert.strictEqual(result[0]?.error, "Loop detected");
		assert.deepStrictEqual(result[0]?.loopDetected, {
			kind: "structural",
			planHash: "hash123",
		});
	});

	test("repo without attempts → totalRetries = 0", () => {
		const repos: Record<string, RepoState> = {
			"repo-1": {
				repository: "/path",
				status: "SUCCESS",
			},
		};
		const result = buildReport(repos);
		assert.strictEqual(result[0]?.totalRetries, 0);
	});

	test("push-only outcome exposes pushed SHAs separately from created commits", () => {
		const result = buildReport({
			"repo-1": {
				repository: "/path",
				status: "SUCCESS",
				operation: "push-only",
				pushedShas: ["first-sha", "second-sha"],
			},
		});

		assert.deepStrictEqual(result[0]?.pushedShas, ["first-sha", "second-sha"]);
		assert.deepStrictEqual(result[0]?.committedShas, []);
	});
});

// ── generateReport ──────────────────────────────────────────────────────────

describe("generateReport — new fields", () => {
	test("SUCCESS with committedShas shows count", () => {
		const repos: Record<string, RepoState> = {
			"repo-1": {
				repository: "/path",
				status: "SUCCESS",
				committedShas: [
					{ sha: "abc123def456", files: ["f1.ts"] },
					{ sha: "def789", files: ["f2.ts"] },
				],
			},
		};
		const report = generateReport(repos);
		assert.ok(report.includes("✅"));
		assert.ok(report.includes("2 commits"));
	});

	test("FAILED with attempts shows retry breakdown", () => {
		const repos: Record<string, RepoState> = {
			"repo-1": {
				repository: "/path",
				status: "FAILED",
				error: "Validation failed",
				attempts: { validation: 1, structural: 0, race: 0, git: 0, network: 0 },
			},
		};
		const report = generateReport(repos);
		assert.ok(report.includes("❌"));
		assert.ok(report.includes("1 retry"));
		assert.ok(report.includes("validation"));
	});

	test("loopDetected appears in report", () => {
		const repos: Record<string, RepoState> = {
			"repo-1": {
				repository: "/path",
				status: "FAILED",
				error: "Loop detected after 2 attempts",
				loopDetected: { kind: "structural", planHash: "h123" },
				attempts: { structural: 2, validation: 0, race: 0, git: 0, network: 0 },
			},
		};
		const report = generateReport(repos);
		assert.ok(report.includes("❌"));
		assert.ok(report.includes("Loop detected"));
		assert.ok(report.includes("structural"));
	});

	test("committed SHA list renders short SHAs", () => {
		const repos: Record<string, RepoState> = {
			"repo-1": {
				repository: "/path",
				status: "SUCCESS",
				committedShas: [
					{ sha: "abcdef1234567890", files: ["src/a.ts", "src/b.ts"] },
				],
			},
		};
		const report = generateReport(repos);
		assert.ok(report.includes("abcdef1")); // sha.slice(0, 7)
		assert.ok(report.includes("src/a.ts"));
	});

	test("push-only success renders its existing-commit publication count", () => {
		const report = generateReport({
			"repo-1": {
				repository: "/path",
				status: "SUCCESS",
				operation: "push-only",
				pushedShas: ["first-sha", "second-sha"],
			},
		});

		assert.match(report, /2 existing commits pushed/u);
		assert.ok(!report.includes("2 commits)"));
	});
});
