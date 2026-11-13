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
	assert.equal(EXPECTED_NODE_TEST_FILES.length, 119);
	assert.equal(new Set(EXPECTED_NODE_TEST_FILES).size, 119);
	for (const file of [
		"unit/prepared-merge-historical-staging.test.ts",
		"unit/prepared-merge-explicit-parents.test.ts",
		"unit/prepared-merge-remote-observation.test.ts",
		"unit/prepared-merge-terminal-state.test.ts",
		"unit/resume-reporting.test.ts",
		"unit/qualification-platform-git.test.ts",
		"unit/qualification-boundary.test.ts",
		"unit/qualification-guard-regressions.test.ts",
		"unit/initial-plan-contract.test.ts",
		"unit/context-admission.test.ts",
		"unit/exact-planning-partitions.test.ts",
		"unit/partitioned-planning-flow.test.ts",
		"unit/planning-review-regressions.test.ts",
		"unit/planning-retry-boundaries.test.ts",
		"unit/planning-terminal-recovery.test.ts",
		"unit/plan-json-sanitization.test.ts",
	])
		assert.ok(EXPECTED_NODE_TEST_FILES.includes(file));
	assert.equal(
		EXPECTED_NODE_TEST_FILES.includes(
			"unit/prepared-merge-review-regressions.test.ts",
		),
		false,
	);
	assert.deepEqual(buildNodeTestArguments(["/tmp/example.test.ts"]), [
		"--test",
		"--test-concurrency=1",
		`--test-timeout=${FIXED_TEST_TIMEOUT_MILLISECONDS}`,
		"--test-reporter=tap",
		"/tmp/example.test.ts",
	]);
});

test("source and compiled qualification use the maintained platform Git wrapper", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
	);
	assert.equal(
		manifest.scripts["test:source"],
		"node scripts/with-platform-git.mjs tests/run-tests.mjs",
	);
	assert.ok(
		manifest.scripts["test:node:build"].startsWith(
			"pnpm run build:node && node scripts/with-platform-git.mjs --test ",
		),
	);
});

test("compiled qualification retains the F2 controller observation oracle", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
	);
	assert.equal(
		manifest.scripts["test:node:build"]
			.split(" ")
			.filter(
				(argument) =>
					argument === "tests/node-build/controller-observation.node.mjs",
			).length,
		1,
	);
});

test("compiled qualification retains the CL-01 controller lifetime oracle", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
	);
	assert.equal(
		manifest.scripts["test:node:build"]
			.split(" ")
			.filter(
				(argument) =>
					argument === "tests/node-build/controller-lifetime.node.mjs",
			).length,
		1,
	);
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

test("CI checks out the exact PR head or push event SHA", () => {
	const workflow = readFileSync(
		new URL("../../.github/workflows/ci.yml", import.meta.url),
		"utf8",
	);
	assert.ok(
		workflow.includes(
			`uses: actions/checkout@v4\n        with:\n          ref: \${{ github.event.pull_request.head.sha || github.sha }}`,
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
