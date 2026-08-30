import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildFailureDiagnostic,
	buildNodeTestArguments,
	EXPECTED_NODE_TEST_FILES,
	FIXED_TEST_TIMEOUT_MILLISECONDS,
} from "../run-tests.mjs";

test("keeps the git-commits-push Node test surface closed and sequential", () => {
	assert.equal(EXPECTED_NODE_TEST_FILES.length, 35);
	assert.equal(new Set(EXPECTED_NODE_TEST_FILES).size, 35);
	assert.deepEqual(buildNodeTestArguments(["/tmp/example.test.ts"]), [
		"--test",
		"--test-concurrency=1",
		`--test-timeout=${FIXED_TEST_TIMEOUT_MILLISECONDS}`,
		"--test-reporter=tap",
		"/tmp/example.test.ts",
	]);
});

test("extracts bounded TAP failure context for GitHub annotations", () => {
	const diagnostic = buildFailureDiagnostic(
		[
			"TAP version 13",
			"# Subtest: passes",
			"ok 1 - passes",
			"# Subtest: fails",
			"not ok 2 - fails",
			"  error: expected true",
			"1..2",
		].join("\n"),
		"stderr context",
	);
	assert.match(diagnostic, /not ok 2 - fails/);
	assert.match(diagnostic, /expected true/);
	assert.ok(diagnostic.length <= 60_000);
});
