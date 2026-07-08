/**
 * tests/unit/errors.test.ts — Unit tests for Phase 1 error classes.
 *
 * Plan reference: §7.2 Error class tests
 *   - Constructor stores fields correctly
 *   - name property matches class name
 *   - instanceof Error is true
 *   - instanceof <specific class> is true
 */

import { describe, expect, test } from "bun:test";
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
		expect(err.message).toBe("test message");
		expect(err.kind).toBe("duplicate-file");
	});

	test.each([
		["duplicate-file" as CommitPlanErrorKind],
		["empty-plans" as CommitPlanErrorKind],
		["missing-file" as CommitPlanErrorKind],
		["nonexistent-file" as CommitPlanErrorKind],
	])("accepts kind '%s'", (kind) => {
		const err = new CommitPlanError("msg", kind);
		expect(err.kind).toBe(kind);
	});

	test("stores optional files array", () => {
		const err = new CommitPlanError("msg", "duplicate-file", ["a.ts", "b.ts"]);
		expect(err.files).toEqual(["a.ts", "b.ts"]);
	});

	test("files defaults to undefined when omitted", () => {
		const err = new CommitPlanError("msg", "empty-plans");
		expect(err.files).toBeUndefined();
	});

	test("stores optional context", () => {
		const context = {
			committedShas: [{ sha: "abc123", files: ["f.ts"] }],
			pendingFiles: ["g.ts"],
		};
		const err = new CommitPlanError("msg", "missing-file", undefined, context);
		expect(err.context).toEqual(context);
	});

	test("context defaults to undefined when omitted", () => {
		const err = new CommitPlanError("msg", "empty-plans");
		expect(err.context).toBeUndefined();
	});

	test("name property matches class name", () => {
		const err = new CommitPlanError("msg", "duplicate-file");
		expect(err.name).toBe("CommitPlanError");
	});

	test("instanceof Error", () => {
		const err = new CommitPlanError("msg", "duplicate-file");
		expect(err).toBeInstanceOf(Error);
	});

	test("instanceof CommitPlanError", () => {
		const err = new CommitPlanError("msg", "duplicate-file");
		expect(err).toBeInstanceOf(CommitPlanError);
	});
});

// ── DiffHashMismatchError ────────────────────────────────────────────────────

describe("DiffHashMismatchError", () => {
	test("has a default message", () => {
		const err = new DiffHashMismatchError();
		expect(err.message).toContain("DiffHash mismatch");
	});

	test("name property matches class name", () => {
		const err = new DiffHashMismatchError();
		expect(err.name).toBe("DiffHashMismatchError");
	});

	test("instanceof Error", () => {
		const err = new DiffHashMismatchError();
		expect(err).toBeInstanceOf(Error);
	});

	test("instanceof DiffHashMismatchError", () => {
		const err = new DiffHashMismatchError();
		expect(err).toBeInstanceOf(DiffHashMismatchError);
	});
});

// ── GitExecError ─────────────────────────────────────────────────────────────

describe("GitExecError", () => {
	test("stores message, command and exitCode", () => {
		const err = new GitExecError("command failed", "git push", 128);
		expect(err.message).toBe("command failed");
		expect(err.command).toBe("git push");
		expect(err.exitCode).toBe(128);
	});

	test("name property matches class name", () => {
		const err = new GitExecError("msg", "git status", 1);
		expect(err.name).toBe("GitExecError");
	});

	test("instanceof Error", () => {
		const err = new GitExecError("msg", "git log", 1);
		expect(err).toBeInstanceOf(Error);
	});

	test("instanceof GitExecError", () => {
		const err = new GitExecError("msg", "git log", 1);
		expect(err).toBeInstanceOf(GitExecError);
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
		expect(err.message).toBe("partial failure");
		expect(err.context).toEqual(sampleContext);
	});

	test("context contains all required fields", () => {
		const err = new PartialCommitError("msg", sampleContext);
		expect(err.context.committedShas).toHaveLength(1);
		expect(err.context.originalHead).toBe("def");
		expect(err.context.failedIndex).toBe(1);
		expect(err.context.totalCount).toBe(3);
		expect(err.context.pendingFiles).toHaveLength(2);
	});

	test("name property matches class name", () => {
		const err = new PartialCommitError("msg", sampleContext);
		expect(err.name).toBe("PartialCommitError");
	});

	test("instanceof Error", () => {
		const err = new PartialCommitError("msg", sampleContext);
		expect(err).toBeInstanceOf(Error);
	});

	test("instanceof PartialCommitError", () => {
		const err = new PartialCommitError("msg", sampleContext);
		expect(err).toBeInstanceOf(PartialCommitError);
	});
});

// ── PushError ────────────────────────────────────────────────────────────────

describe("PushError", () => {
	test("stores transient=true for retryable failures", () => {
		const err = new PushError("network timeout", true);
		expect(err.message).toBe("network timeout");
		expect(err.transient).toBe(true);
	});

	test("stores transient=false for permanent failures", () => {
		const err = new PushError("auth failed", false);
		expect(err.message).toBe("auth failed");
		expect(err.transient).toBe(false);
	});

	test("name property matches class name", () => {
		const err = new PushError("msg", true);
		expect(err.name).toBe("PushError");
	});

	test("instanceof Error", () => {
		const err = new PushError("msg", true);
		expect(err).toBeInstanceOf(Error);
	});

	test("instanceof PushError", () => {
		const err = new PushError("msg", true);
		expect(err).toBeInstanceOf(PushError);
	});
});
