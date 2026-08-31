/**
 * tests/unit/error-classifier.test.ts — Tests for Phase 4 pure helpers.
 *
 * Plan reference:
 *   - §7.4 Error classifier tests (classifyError, getResolutionHint)
 *   - §7.4c LLM-side error classification tests (classifyLLMFailure)
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
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
		assert.deepStrictEqual(result, { kind: "success" });
	});

	test("CommitPlanError(empty-plans) + committedShasExist=false → structural retry", () => {
		const err = new CommitPlanError("empty plans", "empty-plans");
		const result = classifyError(err, false);
		assert.notDeepStrictEqual(result, { kind: "success" });
		if (result.kind !== "success") {
			assert.strictEqual(result.kind, "retry");
			assert.strictEqual(result.error.kind, "structural");
			assert.strictEqual(result.error.message, "empty plans");
		}
	});

	for (const [kind, files] of [
		["duplicate-file", ["a.ts"]],
		["missing-file", ["b.ts"]],
		["nonexistent-file", ["c.ts"]],
	] as const) {
		test(`CommitPlanError(${kind}) → structural retry with resolution_hint`, () => {
			const err = new CommitPlanError(`test ${kind}`, kind, [...files]);
			const result = classifyError(err, true);
			assert.notDeepStrictEqual(result, { kind: "success" });
			if (result.kind !== "success") {
				assert.strictEqual(result.kind, "retry");
				assert.strictEqual(result.error.kind, "structural");
				assert.strictEqual(result.error.message, `test ${kind}`);
				assert.deepStrictEqual(result.error.files, [...files]);
				assert.ok(result.error.resolution_hint);
			}
		});
	}

	// ── DiffHashMismatchError ──────────────────────────────────────────────

	test("DiffHashMismatchError → race retry", () => {
		const err = new DiffHashMismatchError();
		const result = classifyError(err, false);
		assert.notDeepStrictEqual(result, { kind: "success" });
		if (result.kind !== "success") {
			assert.strictEqual(result.kind, "retry");
			assert.strictEqual(result.error.kind, "race");
			assert.ok(result.error.message.includes("DiffHash mismatch"));
			assert.ok(result.error.resolution_hint);
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
		assert.notDeepStrictEqual(result, { kind: "success" });
		if (result.kind !== "success") {
			assert.strictEqual(result.kind, "retry");
			assert.strictEqual(result.error.kind, "git");
			assert.ok(result.error.message.includes("commit 2/3 failed"));
			assert.ok(result.error.resolution_hint);
		}
	});

	// ── GitExecError ───────────────────────────────────────────────────────

	test("GitExecError → git fail (non-retryable)", () => {
		const err = new GitExecError("fatal: index.lock", "git commit", 128);
		const result = classifyError(err, false);
		assert.notDeepStrictEqual(result, { kind: "success" });
		if (result.kind !== "success") {
			assert.strictEqual(result.kind, "fail");
			assert.strictEqual(result.error.kind, "git");
			assert.strictEqual(result.error.message, "fatal: index.lock");
		}
	});

	// ── PushError ──────────────────────────────────────────────────────────

	test("PushError(transient=true) → network retry", () => {
		const err = new PushError("network timeout", true);
		const result = classifyError(err, false);
		assert.notDeepStrictEqual(result, { kind: "success" });
		if (result.kind !== "success") {
			assert.strictEqual(result.kind, "retry");
			assert.strictEqual(result.error.kind, "network");
			assert.strictEqual(result.error.message, "network timeout");
		}
	});

	test("PushError(transient=false) → network fail", () => {
		const err = new PushError("auth failed", false);
		const result = classifyError(err, false);
		assert.notDeepStrictEqual(result, { kind: "success" });
		if (result.kind !== "success") {
			assert.strictEqual(result.kind, "fail");
			assert.strictEqual(result.error.kind, "network");
			assert.strictEqual(result.error.message, "auth failed");
		}
	});

	// ── Unknown errors ─────────────────────────────────────────────────────

	test("unknown Error → git fail (fail-closed)", () => {
		const err = new Error("something unexpected");
		const result = classifyError(err, false);
		assert.notDeepStrictEqual(result, { kind: "success" });
		if (result.kind !== "success") {
			assert.strictEqual(result.kind, "fail");
			assert.strictEqual(result.error.kind, "git");
			assert.strictEqual(result.error.message, "something unexpected");
		}
	});

	test("non-Error value → git fail with string message", () => {
		const result = classifyError("string error", false);
		assert.notDeepStrictEqual(result, { kind: "success" });
		if (result.kind !== "success") {
			assert.strictEqual(result.kind, "fail");
			assert.strictEqual(result.error.kind, "git");
			assert.strictEqual(result.error.message, "string error");
		}
	});
});

// ── getResolutionHint ────────────────────────────────────────────────────────

describe("getResolutionHint", () => {
	test("duplicate-file returns a non-empty hint", () => {
		const hint = getResolutionHint("duplicate-file");
		assert.ok(hint);
		assert.strictEqual(typeof hint, "string");
		assert.ok(hint.includes("Fat Commit"));
	});

	test("missing-file returns a non-empty hint", () => {
		const hint = getResolutionHint("missing-file");
		assert.ok(hint);
		assert.strictEqual(typeof hint, "string");
		assert.ok(hint.includes("no changes"));
	});

	test("nonexistent-file returns a non-empty hint", () => {
		const hint = getResolutionHint("nonexistent-file");
		assert.ok(hint);
		assert.strictEqual(typeof hint, "string");
		assert.ok(hint.includes("does not exist"));
	});

	test("empty-plans returns a non-empty hint", () => {
		const hint = getResolutionHint("empty-plans");
		assert.ok(hint);
		assert.strictEqual(typeof hint, "string");
		assert.ok(hint.includes("empty array"));
	});
});

// ── classifyLLMFailure ───────────────────────────────────────────────────────

describe("classifyLLMFailure", () => {
	// U-GE-34: "validation rejected" → "validation" (documented extension point)
	test("U-GE-34 | 'validation rejected' → returns 'validation'", () => {
		const result = classifyLLMFailure("validation rejected: bad format");
		assert.strictEqual(result, "validation");
	});

	// U-GE-35: "LLM Fatal Error: ..." → null (fail-closed)
	test("U-GE-35 | 'LLM Fatal Error: ...' → returns null", () => {
		const result = classifyLLMFailure(
			"LLM Fatal Error: LLM returned an invalid response",
		);
		assert.strictEqual(result, null);
	});

	// U-GE-35 variant: JSON parse error
	test("U-GE-35b | 'LLM Fatal Error: Unexpected token' → returns null", () => {
		const result = classifyLLMFailure(
			"LLM Fatal Error: Unexpected token '<' in JSON",
		);
		assert.strictEqual(result, null);
	});

	// U-GE-36: "LLM Fatal Error: network timeout" → null
	test("U-GE-36 | 'LLM Fatal Error: network timeout' → returns null", () => {
		const result = classifyLLMFailure(
			"LLM Fatal Error: network timeout after 30s",
		);
		assert.strictEqual(result, null);
	});

	// U-GE-37: unknown error (no prefix) → null
	test("U-GE-37 | unknown error string → returns null", () => {
		const result = classifyLLMFailure("Something went wrong");
		assert.strictEqual(result, null);
	});

	// Edge: empty string → null
	test("empty string → returns null", () => {
		const result = classifyLLMFailure("");
		assert.strictEqual(result, null);
	});
});
