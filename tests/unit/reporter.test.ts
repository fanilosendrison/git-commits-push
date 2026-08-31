// tests/unit/reporter.test.ts — Unit tests for src/modules/reporter.ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	generateReport,
	printReport,
} from "../../src/modules/core/reporter.ts";
import type { RepoState } from "../../src/types.ts";

const SUCCESS_REPO: RepoState = {
	repository: "/repo/a",
	status: "SUCCESS",
	commits: [
		{
			commit: { type: "feat", description: "add feature", isBreaking: false },
			files: ["file.ts"],
		},
	],
};

const FAILED_REPO: RepoState = {
	repository: "/repo/b",
	status: "FAILED",
	error: "Tests échoués",
};

describe("U-RE-01 | generateReport — header present", () => {
	test("contains === TURNLOCK EXECUTION REPORT ===", () => {
		const report = generateReport({});
		assert.ok(report.includes("=== TURNLOCK EXECUTION REPORT ==="));
	});
});

describe("U-RE-02 | generateReport — SUCCESS line", () => {
	test("shows ✅ for a SUCCESS repo", () => {
		const report = generateReport({ abc123: SUCCESS_REPO });
		assert.ok(report.includes("✅"));
		assert.ok(report.includes("abc123"));
	});
});

describe("U-RE-03 | generateReport — FAILED line", () => {
	test("shows ❌ for a FAILED repo", () => {
		const report = generateReport({ def456: FAILED_REPO });
		assert.ok(report.includes("❌"));
		assert.ok(report.includes("def456"));
	});
});

describe("U-RE-04 | generateReport — FAILED includes error message", () => {
	test("includes the error string in the report line", () => {
		const report = generateReport({ def456: FAILED_REPO });
		assert.ok(report.includes("Tests échoués"));
	});
});

describe("U-RE-05 | printReport — writes to stderr, not stdout", () => {
	test("process.stderr.write is called, process.stdout.write is not", () => {
		const originalStderrWrite = process.stderr.write;
		const originalStdoutWrite = process.stdout.write;
		let stderrWasCalled = false;
		let stdoutWasCalled = false;
		Reflect.set(process.stderr, "write", () => {
			stderrWasCalled = true;
			return true;
		});
		Reflect.set(process.stdout, "write", () => {
			stdoutWasCalled = true;
			return true;
		});

		try {
			printReport({ abc123: SUCCESS_REPO });
		} finally {
			Reflect.set(process.stderr, "write", originalStderrWrite);
			Reflect.set(process.stdout, "write", originalStdoutWrite);
		}

		assert.strictEqual(stderrWasCalled, true);
		assert.strictEqual(stdoutWasCalled, false);
	});
});

describe("U-RE-06 | generateReport — footer present", () => {
	test("contains ================================= footer", () => {
		const report = generateReport({});
		assert.ok(report.includes("================================="));
	});
});

describe("U-RE-07 | generateReport — zero repos", () => {
	test("produces valid report with header and footer even when empty", () => {
		const report = generateReport({});
		assert.ok(report.includes("=== TURNLOCK EXECUTION REPORT ==="));
		assert.ok(report.includes("================================="));
		assert.ok(!report.includes("✅"));
		assert.ok(!report.includes("❌"));
	});
});
