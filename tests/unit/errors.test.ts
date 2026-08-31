/**
 * tests/unit/errors.test.ts — Unit tests for Phase 1 error classes.
 *
 * Plan reference: §7.2 Error class tests
 *   - Constructor stores fields correctly
 *   - name property matches class name
 *   - instanceof Error is true
 *   - instanceof <specific class> is true
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	CommitPlanError,
	type CommitPlanErrorKind,
	DiffHashMismatchError,
	GitExecError,
	PartialCommitError,
	PushError,
} from "../../src/modules/core/errors.ts";

// ── CommitPlanError ─────────────────────────────────────────────────────────

describe("CommitPlanError", () => {
	test("constructor stores message and kind", () => {
		const err = new CommitPlanError("test message", "duplicate-file");
		assert.strictEqual(err.message, "test message");
		assert.strictEqual(err.kind, "duplicate-file");
	});

	for (const kind of [
		"duplicate-file",
		"empty-plans",
		"missing-file",
		"nonexistent-file",
	] as const satisfies readonly CommitPlanErrorKind[]) {
		test(`accepts kind '${kind}'`, () => {
			const err = new CommitPlanError("msg", kind);
			assert.strictEqual(err.kind, kind);
		});
	}

	test("stores optional files array", () => {
		const err = new CommitPlanError("msg", "duplicate-file", ["a.ts", "b.ts"]);
		assert.deepStrictEqual(err.files, ["a.ts", "b.ts"]);
	});

	test("files defaults to undefined when omitted", () => {
		const err = new CommitPlanError("msg", "empty-plans");
		assert.strictEqual(err.files, undefined);
	});

	test("stores optional context", () => {
		const context = {
			committedShas: [{ sha: "abc123", files: ["f.ts"] }],
			pendingFiles: ["g.ts"],
		};
		const err = new CommitPlanError("msg", "missing-file", undefined, context);
		assert.deepStrictEqual(err.context, context);
	});

	test("context defaults to undefined when omitted", () => {
		const err = new CommitPlanError("msg", "empty-plans");
		assert.strictEqual(err.context, undefined);
	});

	test("name property matches class name", () => {
		const err = new CommitPlanError("msg", "duplicate-file");
		assert.strictEqual(err.name, "CommitPlanError");
	});

	test("instanceof Error", () => {
		const err = new CommitPlanError("msg", "duplicate-file");
		assert.ok(err instanceof Error);
	});

	test("instanceof CommitPlanError", () => {
		const err = new CommitPlanError("msg", "duplicate-file");
		assert.ok(err instanceof CommitPlanError);
	});
});

// ── DiffHashMismatchError ────────────────────────────────────────────────────

describe("DiffHashMismatchError", () => {
	test("has a default message", () => {
		const err = new DiffHashMismatchError();
		assert.ok(err.message.includes("DiffHash mismatch"));
	});

	test("name property matches class name", () => {
		const err = new DiffHashMismatchError();
		assert.strictEqual(err.name, "DiffHashMismatchError");
	});

	test("instanceof Error", () => {
		const err = new DiffHashMismatchError();
		assert.ok(err instanceof Error);
	});

	test("instanceof DiffHashMismatchError", () => {
		const err = new DiffHashMismatchError();
		assert.ok(err instanceof DiffHashMismatchError);
	});
});

// ── GitExecError ─────────────────────────────────────────────────────────────

describe("GitExecError", () => {
	test("stores message, command and exitCode", () => {
		const err = new GitExecError("command failed", "git push", 128);
		assert.strictEqual(err.message, "command failed");
		assert.strictEqual(err.command, "git push");
		assert.strictEqual(err.exitCode, 128);
	});

	test("name property matches class name", () => {
		const err = new GitExecError("msg", "git status", 1);
		assert.strictEqual(err.name, "GitExecError");
	});

	test("instanceof Error", () => {
		const err = new GitExecError("msg", "git log", 1);
		assert.ok(err instanceof Error);
	});

	test("instanceof GitExecError", () => {
		const err = new GitExecError("msg", "git log", 1);
		assert.ok(err instanceof GitExecError);
	});
});

// ── PartialCommitError ───────────────────────────────────────────────────────

describe("PartialCommitError", () => {
	const sampleContext = {
		committedShas: [{ sha: "abc", files: ["f1.ts"] }],
		originalHead: "def",
		failedIndex: 1,
		totalCount: 3,
		pendingFiles: ["f2.ts", "f3.ts"],
	};

	test("stores message and context", () => {
		const err = new PartialCommitError("partial failure", sampleContext);
		assert.strictEqual(err.message, "partial failure");
		assert.deepStrictEqual(err.context, sampleContext);
	});

	test("context contains all required fields", () => {
		const err = new PartialCommitError("msg", sampleContext);
		assert.strictEqual(err.context.committedShas.length, 1);
		assert.strictEqual(err.context.originalHead, "def");
		assert.strictEqual(err.context.failedIndex, 1);
		assert.strictEqual(err.context.totalCount, 3);
		assert.strictEqual(err.context.pendingFiles.length, 2);
	});

	test("name property matches class name", () => {
		const err = new PartialCommitError("msg", sampleContext);
		assert.strictEqual(err.name, "PartialCommitError");
	});

	test("instanceof Error", () => {
		const err = new PartialCommitError("msg", sampleContext);
		assert.ok(err instanceof Error);
	});

	test("instanceof PartialCommitError", () => {
		const err = new PartialCommitError("msg", sampleContext);
		assert.ok(err instanceof PartialCommitError);
	});
});

// ── PushError ────────────────────────────────────────────────────────────────

describe("PushError", () => {
	test("stores transient=true for retryable failures", () => {
		const err = new PushError("network timeout", true);
		assert.strictEqual(err.message, "network timeout");
		assert.strictEqual(err.transient, true);
	});

	test("stores transient=false for permanent failures", () => {
		const err = new PushError("auth failed", false);
		assert.strictEqual(err.message, "auth failed");
		assert.strictEqual(err.transient, false);
	});

	test("name property matches class name", () => {
		const err = new PushError("msg", true);
		assert.strictEqual(err.name, "PushError");
	});

	test("instanceof Error", () => {
		const err = new PushError("msg", true);
		assert.ok(err instanceof Error);
	});

	test("instanceof PushError", () => {
		const err = new PushError("msg", true);
		assert.ok(err instanceof PushError);
	});
});
