/**
 * tests/unit/error-classifier.test.ts — Tests for Phase 4 pure helpers.
 *
 * Plan reference:
 *   - §7.4 Error classifier tests (classifyError, getResolutionHint)
 *   - §7.4c LLM-side error classification tests (classifyLLMFailure)
 */

import { describe, expect, test } from "bun:test";
import {
	classifyError,
	classifyLLMFailure,
	getResolutionHint,
} from "../../src/modules/core/error-classifier.ts";
import {
	CommitPlanError,
	DiffHashMismatchError,
	GitExecError,
	PartialCommitError,
	PushError,
} from "../../src/modules/core/errors.ts";

// ── classifyError ────────────────────────────────────────────────────────────

describe("classifyError", () => {
	// ── CommitPlanError ────────────────────────────────────────────────────

	test("CommitPlanError(empty-plans) + committedShasExist=true → success", () => {
		const err = new CommitPlanError("empty plans", "empty-plans");
		const result = classifyError(err, true);
		expect(result).toEqual({ kind: "success" });
	});

	test("CommitPlanError(empty-plans) + committedShasExist=false → structural retry", () => {
		const err = new CommitPlanError("empty plans", "empty-plans");
		const result = classifyError(err, false);
		expect(result).not.toEqual({ kind: "success" });
		if (result.kind !== "success") {
			expect(result.kind).toBe("retry");
			expect(result.error.kind).toBe("structural");
			expect(result.error.message).toBe("empty plans");
		}
	});

	test.each([
		["duplicate-file", ["a.ts"]],
		["missing-file", ["b.ts"]],
		["nonexistent-file", ["c.ts"]],
	] as const)("CommitPlanError(%s) → structural retry with resolution_hint", (kind, files) => {
		const err = new CommitPlanError(`test ${kind}`, kind, [...files]);
		const result = classifyError(err, true);
		expect(result).not.toEqual({ kind: "success" });
		if (result.kind !== "success") {
			expect(result.kind).toBe("retry");
			expect(result.error.kind).toBe("structural");
			expect(result.error.message).toBe(`test ${kind}`);
			expect(result.error.files).toEqual([...files]);
			expect(result.error.resolution_hint).toBeTruthy();
		}
	});

	// ── DiffHashMismatchError ──────────────────────────────────────────────

	test("DiffHashMismatchError → race retry", () => {
		const err = new DiffHashMismatchError();
		const result = classifyError(err, false);
		expect(result).not.toEqual({ kind: "success" });
		if (result.kind !== "success") {
			expect(result.kind).toBe("retry");
			expect(result.error.kind).toBe("race");
			expect(result.error.message).toContain("DiffHash mismatch");
			expect(result.error.resolution_hint).toBeTruthy();
		}
	});

	// ── PartialCommitError ─────────────────────────────────────────────────

	test("PartialCommitError → git retry", () => {
		const ctx = {
			committedShas: [{ sha: "abc", files: ["f1.ts"] }],
			originalHead: "def",
			failedIndex: 1,
			totalCount: 3,
			pendingFiles: ["f2.ts"],
		};
		const err = new PartialCommitError("commit 2/3 failed", ctx);
		const result = classifyError(err, false);
		expect(result).not.toEqual({ kind: "success" });
		if (result.kind !== "success") {
			expect(result.kind).toBe("retry");
			expect(result.error.kind).toBe("git");
			expect(result.error.message).toContain("commit 2/3 failed");
			expect(result.error.resolution_hint).toBeTruthy();
		}
	});

	// ── GitExecError ───────────────────────────────────────────────────────

	test("GitExecError → git fail (non-retryable)", () => {
		const err = new GitExecError("fatal: index.lock", "git commit", 128);
		const result = classifyError(err, false);
		expect(result).not.toEqual({ kind: "success" });
		if (result.kind !== "success") {
			expect(result.kind).toBe("fail");
			expect(result.error.kind).toBe("git");
			expect(result.error.message).toBe("fatal: index.lock");
		}
	});

	// ── PushError ──────────────────────────────────────────────────────────

	test("PushError(transient=true) → network retry", () => {
		const err = new PushError("network timeout", true);
		const result = classifyError(err, false);
		expect(result).not.toEqual({ kind: "success" });
		if (result.kind !== "success") {
			expect(result.kind).toBe("retry");
			expect(result.error.kind).toBe("network");
			expect(result.error.message).toBe("network timeout");
		}
	});

	test("PushError(transient=false) → network fail", () => {
		const err = new PushError("auth failed", false);
		const result = classifyError(err, false);
		expect(result).not.toEqual({ kind: "success" });
		if (result.kind !== "success") {
			expect(result.kind).toBe("fail");
			expect(result.error.kind).toBe("network");
			expect(result.error.message).toBe("auth failed");
		}
	});

	// ── Unknown errors ─────────────────────────────────────────────────────

	test("unknown Error → git fail (fail-closed)", () => {
		const err = new Error("something unexpected");
		const result = classifyError(err, false);
		expect(result).not.toEqual({ kind: "success" });
		if (result.kind !== "success") {
			expect(result.kind).toBe("fail");
			expect(result.error.kind).toBe("git");
			expect(result.error.message).toBe("something unexpected");
		}
	});

	test("non-Error value → git fail with string message", () => {
		const result = classifyError("string error", false);
		expect(result).not.toEqual({ kind: "success" });
		if (result.kind !== "success") {
			expect(result.kind).toBe("fail");
			expect(result.error.kind).toBe("git");
			expect(result.error.message).toBe("string error");
		}
	});
});

// ── getResolutionHint ────────────────────────────────────────────────────────

describe("getResolutionHint", () => {
	test("duplicate-file returns a non-empty hint", () => {
		const hint = getResolutionHint("duplicate-file");
		expect(hint).toBeTruthy();
		expect(typeof hint).toBe("string");
		expect(hint).toContain("Fat Commit");
	});

	test("missing-file returns a non-empty hint", () => {
		const hint = getResolutionHint("missing-file");
		expect(hint).toBeTruthy();
		expect(typeof hint).toBe("string");
		expect(hint).toContain("no changes");
	});

	test("nonexistent-file returns a non-empty hint", () => {
		const hint = getResolutionHint("nonexistent-file");
		expect(hint).toBeTruthy();
		expect(typeof hint).toBe("string");
		expect(hint).toContain("does not exist");
	});

	test("empty-plans returns a non-empty hint", () => {
		const hint = getResolutionHint("empty-plans");
		expect(hint).toBeTruthy();
		expect(typeof hint).toBe("string");
		expect(hint).toContain("empty array");
	});
});

// ── classifyLLMFailure ───────────────────────────────────────────────────────

describe("classifyLLMFailure", () => {
	// U-GE-34: "validation rejected" → "validation" (documented extension point)
	test("U-GE-34 | 'validation rejected' → returns 'validation'", () => {
		const result = classifyLLMFailure("validation rejected: bad format");
		expect(result).toBe("validation");
	});

	// U-GE-35: "LLM Fatal Error: ..." → null (fail-closed)
	test("U-GE-35 | 'LLM Fatal Error: ...' → returns null", () => {
		const result = classifyLLMFailure(
			"LLM Fatal Error: LLM returned an invalid response",
		);
		expect(result).toBeNull();
	});

	// U-GE-35 variant: JSON parse error
	test("U-GE-35b | 'LLM Fatal Error: Unexpected token' → returns null", () => {
		const result = classifyLLMFailure(
			"LLM Fatal Error: Unexpected token '<' in JSON",
		);
		expect(result).toBeNull();
	});

	// U-GE-36: "LLM Fatal Error: network timeout" → null
	test("U-GE-36 | 'LLM Fatal Error: network timeout' → returns null", () => {
		const result = classifyLLMFailure(
			"LLM Fatal Error: network timeout after 30s",
		);
		expect(result).toBeNull();
	});

	// U-GE-37: unknown error (no prefix) → null
	test("U-GE-37 | unknown error string → returns null", () => {
		const result = classifyLLMFailure("Something went wrong");
		expect(result).toBeNull();
	});

	// Edge: empty string → null
	test("empty string → returns null", () => {
		const result = classifyLLMFailure("");
		expect(result).toBeNull();
	});
});
