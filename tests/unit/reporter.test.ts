// tests/unit/reporter.test.ts — Unit tests for src/modules/reporter.ts
import { describe, expect, test, mock, spyOn } from "bun:test";
import { generateReport, printReport } from "../../src/modules/reporter.ts";
import type { RepoState } from "../../src/types.ts";

const SUCCESS_REPO: RepoState = {
	repository: "/repo/a",
	status: "SUCCESS",
	commit: { type: "feat", description: "add feature", isBreaking: false },
};

const FAILED_REPO: RepoState = {
	repository: "/repo/b",
	status: "FAILED",
	error: "Tests échoués",
};

describe("U-RE-01 | generateReport — header present", () => {
	test("contains === TURNLOCK EXECUTION REPORT ===", () => {
		const report = generateReport({});
		expect(report).toContain("=== TURNLOCK EXECUTION REPORT ===");
	});
});

describe("U-RE-02 | generateReport — SUCCESS line", () => {
	test("shows ✅ for a SUCCESS repo", () => {
		const report = generateReport({ "abc123": SUCCESS_REPO });
		expect(report).toContain("✅");
		expect(report).toContain("abc123");
	});
});

describe("U-RE-03 | generateReport — FAILED line", () => {
	test("shows ❌ for a FAILED repo", () => {
		const report = generateReport({ "def456": FAILED_REPO });
		expect(report).toContain("❌");
		expect(report).toContain("def456");
	});
});

describe("U-RE-04 | generateReport — FAILED includes error message", () => {
	test("includes the error string in the report line", () => {
		const report = generateReport({ "def456": FAILED_REPO });
		expect(report).toContain("Tests échoués");
	});
});

describe("U-RE-05 | printReport — writes to stderr, not stdout", () => {
	test("process.stderr.write is called, process.stdout.write is not", () => {
		const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);

		printReport({ "abc123": SUCCESS_REPO });

		expect(stderrSpy).toHaveBeenCalled();
		expect(stdoutSpy).not.toHaveBeenCalled();

		stderrSpy.mockRestore();
		stdoutSpy.mockRestore();
	});
});

describe("U-RE-06 | generateReport — footer present", () => {
	test("contains ================================= footer", () => {
		const report = generateReport({});
		expect(report).toContain("=================================");
	});
});

describe("U-RE-07 | generateReport — zero repos", () => {
	test("produces valid report with header and footer even when empty", () => {
		const report = generateReport({});
		expect(report).toContain("=== TURNLOCK EXECUTION REPORT ===");
		expect(report).toContain("=================================");
		expect(report).not.toContain("✅");
		expect(report).not.toContain("❌");
	});
});
