/**
 * tests/unit/feedback-formatter.test.ts — Tests for feedback formatting (Phase 5)
 *
 * Plan ref: §7.3 Bridge tests
 *   - Structural + duplicate-file → contains [STRUCTURAL], → Resolution:, → Affected files:
 *   - Partial commit → contains Already committed, <remaining-diff>
 *   - Validation → backward-compat error lines
 *   - No feedback → empty result
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatFeedbackBlock } from "../../src/modules/core/feedback-formatter.ts";
import type { Feedback } from "../../src/types.ts";

// ── No feedback ─────────────────────────────────────────────────────────────

describe("formatFeedbackBlock — no feedback", () => {
	test("undefined feedback → empty string", () => {
		assert.strictEqual(formatFeedbackBlock(undefined), "");
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
		assert.ok(result.includes("[STRUCTURAL]"));
	});

	test("contains → Resolution:", () => {
		const result = formatFeedbackBlock(feedback);
		assert.ok(result.includes("→ Resolution:"));
	});

	test("contains → Affected files:", () => {
		const result = formatFeedbackBlock(feedback);
		assert.ok(result.includes("→ Affected files:"));
	});

	test("contains the error message", () => {
		const result = formatFeedbackBlock(feedback);
		assert.ok(result.includes("shared.ts"));
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
		assert.ok(result.includes("[VALIDATION]"));
	});

	test("contains → Resolution:", () => {
		const result = formatFeedbackBlock(feedback);
		assert.ok(result.includes("→ Resolution:"));
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
		assert.ok(result.includes("[RACE]"));
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
		assert.ok(result.includes("[GIT]"));
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
		assert.ok(result.includes("[NETWORK]"));
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
		assert.ok(result.includes("Already committed"));
	});

	test("contains short SHA (7 chars)", () => {
		const result = formatFeedbackBlock(feedback);
		assert.ok(result.includes("abc123d"));
	});

	test("contains committed files list", () => {
		const result = formatFeedbackBlock(feedback);
		assert.ok(result.includes("src/a.ts"));
	});

	test("contains 'Pending files' section", () => {
		const result = formatFeedbackBlock(feedback);
		assert.ok(result.includes("Pending files"));
	});

	test("contains pending files", () => {
		const result = formatFeedbackBlock(feedback);
		assert.ok(result.includes("src/b.ts"));
		assert.ok(result.includes("src/c.ts"));
	});

	test("contains <remaining-diff> block when payloadDiff provided", () => {
		const result = formatFeedbackBlock(feedback, "+export const b = 1;\n");
		assert.ok(result.includes("<remaining-diff>"));
		assert.ok(result.includes("export const b = 1"));
		assert.ok(result.includes("</remaining-diff>"));
	});

	test("no <remaining-diff> when payloadDiff omitted", () => {
		const result = formatFeedbackBlock(feedback);
		assert.ok(!result.includes("<remaining-diff>"));
	});

	test("contains previous_commit history", () => {
		const result = formatFeedbackBlock(feedback);
		assert.ok(result.includes("previous plan text"));
	});

	test("contains instruction to return [] when done", () => {
		const result = formatFeedbackBlock(feedback);
		// When there are pending files, we expect the retry instruction
		assert.ok(result.includes("Generate a NEW JSON"));
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
		assert.ok(result.includes("empty array []"));
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
		assert.ok(result.includes("[STRUCTURAL]"));
		assert.ok(result.includes("[VALIDATION]"));
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
		assert.ok(result.includes("some history"));
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
		assert.ok(result.includes("→ Resolution:"));
		assert.ok(result.includes("Check pending files"));
		assert.ok(!result.includes("→ Affected files:"));
	});
});
