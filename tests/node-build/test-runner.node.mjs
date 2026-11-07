import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	buildFailureDiagnostic,
	buildNodeTestArguments,
	buildNodeTestEnvironment,
	EXPECTED_NODE_TEST_FILES,
	FIXED_TEST_TIMEOUT_MILLISECONDS,
} from "../run-tests.mjs";

test("keeps the git-commits-push Node test surface closed and sequential", () => {
	assert.equal(EXPECTED_NODE_TEST_FILES.length, 89);
	assert.equal(new Set(EXPECTED_NODE_TEST_FILES).size, 89);
	assert.deepEqual(buildNodeTestArguments(["/tmp/example.test.ts"]), [
		"--test",
		"--test-concurrency=1",
		`--test-timeout=${FIXED_TEST_TIMEOUT_MILLISECONDS}`,
		"--test-reporter=tap",
		"/tmp/example.test.ts",
	]);
});

test("keeps the package Node-build timeout aligned with the source runner", () => {
	assert.equal(FIXED_TEST_TIMEOUT_MILLISECONDS, 600_000);
	const packageManifest = JSON.parse(
		readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
	);
	assert.match(
		packageManifest.scripts["test:node:build"],
		new RegExp(
			`--test-timeout=${FIXED_TEST_TIMEOUT_MILLISECONDS}(?:\\s|$)`,
			"u",
		),
	);
});

test("isolates the closed Node suite from publication settings", () => {
	assert.deepEqual(
		buildNodeTestEnvironment({
			NODE_ENV: "production",
			RETAINED_VALUE: "retained",
			TURNLOCK_SKILL_SETTINGS_PATH: "/tmp/publication-settings.json",
		}),
		{
			NODE_ENV: "test",
			RETAINED_VALUE: "retained",
		},
	);
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
