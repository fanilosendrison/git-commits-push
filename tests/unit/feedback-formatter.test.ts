/**
 * tests/unit/feedback-formatter.test.ts — Tests for feedback formatting (Phase 5)
 *
 * Plan ref: §7.3 Bridge tests
 *   - Structural + duplicate-file → contains [STRUCTURAL], → Resolution:, → Affected files:
 *   - Partial commit → contains Already committed, <remaining-diff>
 *   - Validation → backward-compat error lines
 *   - No feedback → empty result
 */

import { describe, expect, test } from "bun:test";
import { formatFeedbackBlock } from "../../src/modules/feedback-formatter.ts";
import type { Feedback } from "../../src/types.ts";

// ── No feedback ─────────────────────────────────────────────────────────────

describe("formatFeedbackBlock — no feedback", () => {
	test("undefined feedback → empty string", () => {
		expect(formatFeedbackBlock(undefined)).toBe("");
	});
});

// ── Structural error ────────────────────────────────────────────────────────

describe("formatFeedbackBlock — structural errors", () => {
	const feedback: Feedback = {
		previous_commit: "",
		errors: [
			{
				kind: "structural",
				message: 'File "shared.ts" appears in multiple plans.',
				resolution_hint:
					"Either split the duplicated file beforehand, or merge all changes touching it into a single Fat Commit plan.",
				files: ["shared.ts"],
			},
		],
	};

	test("contains [STRUCTURAL] prefix", () => {
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("[STRUCTURAL]");
	});

	test("contains → Resolution:", () => {
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("→ Resolution:");
	});

	test("contains → Affected files:", () => {
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("→ Affected files:");
	});

	test("contains the error message", () => {
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("shared.ts");
	});
});

// ── Validation error ─────────────────────────────────────────────────────────

describe("formatFeedbackBlock — validation errors", () => {
	const feedback: Feedback = {
		previous_commit: "",
		errors: [
			{
				kind: "validation",
				message: "[feat: add feature] subject exceeds 72 chars",
				resolution_hint:
					"Rewrite the commit message to comply with Conventional Commits.",
			},
		],
	};

	test("contains [VALIDATION] prefix", () => {
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("[VALIDATION]");
	});

	test("contains → Resolution:", () => {
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("→ Resolution:");
	});
});

// ── Race error ───────────────────────────────────────────────────────────────

describe("formatFeedbackBlock — race errors", () => {
	const feedback: Feedback = {
		previous_commit: "",
		errors: [
			{
				kind: "race",
				message:
					"DiffHash mismatch: The staged diff changed during LLM inference.",
				resolution_hint:
					"The diff changed during inference. Regenerate based on the current diff.",
			},
		],
	};

	test("contains [RACE] prefix", () => {
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("[RACE]");
	});
});

// ── Git error ────────────────────────────────────────────────────────────────

describe("formatFeedbackBlock — git errors", () => {
	const feedback: Feedback = {
		previous_commit: "",
		errors: [
			{
				kind: "git",
				message: "Commit 2/3 failed.",
				resolution_hint:
					"Re-decide the plan based on the pending files (provided below).",
			},
		],
	};

	test("contains [GIT] prefix", () => {
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("[GIT]");
	});
});

// ── Network error ────────────────────────────────────────────────────────────

describe("formatFeedbackBlock — network errors", () => {
	const feedback: Feedback = {
		previous_commit: "",
		errors: [
			{
				kind: "network",
				message: "Push failed: Could not resolve host: github.com",
			},
		],
	};

	test("contains [NETWORK] prefix", () => {
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("[NETWORK]");
	});
});

// ── Partial commit with committed_shas ──────────────────────────────────────

describe("formatFeedbackBlock — partial commit with committed_shas", () => {
	const feedback: Feedback = {
		previous_commit: "previous plan text",
		errors: [
			{
				kind: "git",
				message: "Commit 2/3 failed. 1 commit already in history.",
				resolution_hint:
					"Re-decide the plan based on the pending files (provided below).",
			},
		],
		committed_shas: [{ sha: "abc123def456", files: ["src/a.ts"] }],
		pending_files: ["src/b.ts", "src/c.ts"],
	};

	test("contains 'Already committed' section", () => {
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("Already committed");
	});

	test("contains short SHA (7 chars)", () => {
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("abc123d");
	});

	test("contains committed files list", () => {
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("src/a.ts");
	});

	test("contains 'Pending files' section", () => {
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("Pending files");
	});

	test("contains pending files", () => {
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("src/b.ts");
		expect(result).toContain("src/c.ts");
	});

	test("contains <remaining-diff> block when payloadDiff provided", () => {
		const result = formatFeedbackBlock(feedback, "+export const b = 1;\n");
		expect(result).toContain("<remaining-diff>");
		expect(result).toContain("export const b = 1");
		expect(result).toContain("</remaining-diff>");
	});

	test("no <remaining-diff> when payloadDiff omitted", () => {
		const result = formatFeedbackBlock(feedback);
		expect(result).not.toContain("<remaining-diff>");
	});

	test("contains previous_commit history", () => {
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("previous plan text");
	});

	test("contains instruction to return [] when done", () => {
		const result = formatFeedbackBlock(feedback);
		// When there are pending files, we expect the retry instruction
		expect(result).toContain("Generate a NEW JSON");
	});
});

// ── All done (no pending files, committed_shas present) ────────────────────

describe("formatFeedbackBlock — all work done (no pending files)", () => {
	const feedback: Feedback = {
		previous_commit: "all work was done",
		errors: [],
		committed_shas: [{ sha: "abc123def456", files: ["src/all.ts"] }],
	};

	test("instruction to return [] when everything committed", () => {
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("empty array []");
	});
});

// ── Multiple errors ─────────────────────────────────────────────────────────

describe("formatFeedbackBlock — multiple errors", () => {
	const feedback: Feedback = {
		previous_commit: "",
		errors: [
			{
				kind: "structural",
				message: "Duplicated file.",
				files: ["a.ts"],
			},
			{
				kind: "validation",
				message: "Bad commit message.",
				resolution_hint: "Fix the message.",
			},
		],
	};

	test("contains both [STRUCTURAL] and [VALIDATION]", () => {
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("[STRUCTURAL]");
		expect(result).toContain("[VALIDATION]");
	});
});

// ── No errors, no shas → just previous_commit ───────────────────────────────

describe("formatFeedbackBlock — edge cases", () => {
	test("empty errors array, no shas → still renders", () => {
		const feedback: Feedback = {
			previous_commit: "some history",
			errors: [],
		};
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("some history");
	});

	test("error with resolution_hint but no files", () => {
		const feedback: Feedback = {
			previous_commit: "",
			errors: [
				{
					kind: "structural",
					message: "Empty plans.",
					resolution_hint: "Check pending files.",
				},
			],
		};
		const result = formatFeedbackBlock(feedback);
		expect(result).toContain("→ Resolution:");
		expect(result).toContain("Check pending files");
		expect(result).not.toContain("→ Affected files:");
	});
});
