/**
 * tests/unit/reporter-v2.test.ts — Tests for Phase 8 reporter update.
 *
 * Plan ref: §8.0 Reporter contract (R39, R62)
 *   - buildReport() maps RepoState[] → RepoReport[]
 *   - generateReport() renders new fields: committedShas, attempts, loopDetected
 *   - totalRetries computed as sum of attempts
 */

import { describe, expect, test } from "bun:test";
import { buildReport, generateReport } from "../../src/modules/reporter.ts";
import type { RepoState } from "../../src/types.ts";

// ── buildReport ──────────────────────────────────────────────────────────────

describe("buildReport", () => {
	test("empty repos → empty array", () => {
		const result = buildReport({});
		expect(result).toEqual([]);
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
		expect(result).toHaveLength(1);
		expect(result[0]?.repository).toBe("/path/a");
		expect(result[0]?.status).toBe("SUCCESS");
		expect(result[0]?.committedShas).toHaveLength(1);
		expect(result[0]?.committedShas[0]?.sha).toBe("abc123");
		expect(result[0]?.attempts).toEqual({
			structural: 1,
			validation: 0,
			race: 0,
			git: 0,
			network: 0,
		});
		expect(result[0]?.totalRetries).toBe(1);
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
		expect(result[0]?.totalRetries).toBe(6); // 2+3+0+1+0
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
		expect(result[0]?.error).toBe("Loop detected");
		expect(result[0]?.loopDetected).toEqual({
			kind: "structural",
			planHash: "hash123",
		});
	});

	test("ESCALATED status is preserved", () => {
		const repos: Record<string, RepoState> = {
			"repo-1": {
				repository: "/path",
				status: "ESCALATED",
			},
		};
		const result = buildReport(repos);
		expect(result[0]?.status).toBe("ESCALATED");
	});

	test("repo without attempts → totalRetries = 0", () => {
		const repos: Record<string, RepoState> = {
			"repo-1": {
				repository: "/path",
				status: "SUCCESS",
			},
		};
		const result = buildReport(repos);
		expect(result[0]?.totalRetries).toBe(0);
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
		expect(report).toContain("✅");
		expect(report).toContain("2 commits");
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
		expect(report).toContain("❌");
		expect(report).toContain("1 tentative");
		expect(report).toContain("validation");
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
		expect(report).toContain("❌");
		expect(report).toContain("Loop detected");
		expect(report).toContain("structural");
	});

	test("ESCALATED appears in report", () => {
		const repos: Record<string, RepoState> = {
			"repo-1": {
				repository: "/path",
				status: "ESCALATED",
			},
		};
		const report = generateReport(repos);
		expect(report).toContain("Escaladé");
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
		expect(report).toContain("abcdef1"); // sha.slice(0, 7)
		expect(report).toContain("src/a.ts");
	});
});
