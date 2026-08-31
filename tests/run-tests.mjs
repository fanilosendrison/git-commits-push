import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const FIXED_TEST_TIMEOUT_MILLISECONDS = 180_000;
export const EXPECTED_NODE_TEST_FILES = Object.freeze([
	"acceptance/a1-initial-run.test.ts",
	"acceptance/a2-resume-run.test.ts",
	"acceptance/a3-fallback-escalation.test.ts",
	"acceptance/a4-queued-order-observability.test.ts",
	"acceptance/a5-v2-full-pipeline.test.ts",
	"invariants/i1-secret-scanner.test.ts",
	"invariants/i1b-secret-scanner-warning-path.test.ts",
	"invariants/i2-non-interactive-shell.test.ts",
	"invariants/i3-parallel-isolation.test.ts",
	"invariants/i4-stdout-compliance.test.ts",
	"invariants/i5-test-environment-safety.test.ts",
	"property/p1-diffhash-race.test.ts",
	"property/p2-detached-head.test.ts",
	"property/p3-push-fallback.test.ts",
	"property/p4-push-no-remote.test.ts",
	"unit/auth-resolver.test.ts",
	"unit/commit-message-validator.test.ts",
	"unit/discovery.test.ts",
	"unit/error-classifier.test.ts",
	"unit/errors.test.ts",
	"unit/fallback-model.test.ts",
	"unit/feedback-formatter.test.ts",
	"unit/git-publisher-v2.test.ts",
	"unit/git-publisher.test.ts",
	"unit/lock-manager.test.ts",
	"unit/orchestrator-schema.test.ts",
	"unit/order-store.test.ts",
	"unit/pre-commit-validators.test.ts",
	"unit/queue-retry.test.ts",
	"unit/reporter-v2.test.ts",
	"unit/reporter.test.ts",
	"unit/secret-scanner.test.ts",
	"unit/settings.test.ts",
	"unit/skill-stats-log.test.ts",
	"unit/turnlock-to-llm-bridge.test.ts",
]);

export async function resolveExpectedTestFiles(testDirectory) {
	const absoluteTestDirectory = path.resolve(testDirectory);
	const resolvedTestFiles = [];
	for (const expectedTestFile of EXPECTED_NODE_TEST_FILES) {
		const absoluteTestFile = path.resolve(
			absoluteTestDirectory,
			expectedTestFile,
		);
		const relativeTestFile = path.relative(
			absoluteTestDirectory,
			absoluteTestFile,
		);
		if (
			relativeTestFile.length === 0 ||
			relativeTestFile === ".." ||
			relativeTestFile.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relativeTestFile)
		) {
			throw new Error(
				`Expected Node test path must stay inside the package test directory: ${JSON.stringify(expectedTestFile)}`,
			);
		}
		const stats = await stat(absoluteTestFile);
		if (!stats.isFile()) {
			throw new Error(
				`Expected Node test path is not a file: ${expectedTestFile}`,
			);
		}
		resolvedTestFiles.push(absoluteTestFile);
	}
	return resolvedTestFiles;
}

export function buildNodeTestArguments(resolvedTestFiles) {
	return [
		"--test",
		"--test-concurrency=1",
		`--test-timeout=${FIXED_TEST_TIMEOUT_MILLISECONDS}`,
		"--test-reporter=tap",
		...resolvedTestFiles,
	];
}

export function buildNodeTestEnvironment(environment = process.env) {
	return {
		...environment,
		NODE_ENV: "test",
	};
}

export function buildFailureDiagnostic(stdout, stderr) {
	const lines = `${stdout}\n${stderr}`.split("\n");
	const selectedLines = [];
	for (let index = 0; index < lines.length; index++) {
		if (!/^\s*not ok\b/.test(lines[index] ?? "")) continue;
		selectedLines.push(
			...lines.slice(
				Math.max(0, index - 3),
				Math.min(lines.length, index + 30),
			),
		);
	}
	return selectedLines.join("\n").slice(0, 60_000);
}

function writeGitHubFailureAnnotation(stdout, stderr) {
	if (process.env.GITHUB_ACTIONS !== "true") return;
	const diagnostic = buildFailureDiagnostic(stdout, stderr);
	if (!diagnostic) return;
	const escapedDiagnostic = diagnostic
		.replaceAll("%", "%25")
		.replaceAll("\r", "%0D")
		.replaceAll("\n", "%0A");
	process.stderr.write(
		`::error title=git-commits-push source test failure::${escapedDiagnostic}\n`,
	);
}

export async function runExpectedNodeTests(testDirectory) {
	const resolvedTestFiles = await resolveExpectedTestFiles(testDirectory);
	const result = spawnSync(
		process.execPath,
		buildNodeTestArguments(resolvedTestFiles),
		{
			cwd: path.resolve(testDirectory, ".."),
			encoding: "utf8",
			env: buildNodeTestEnvironment(),
			maxBuffer: 50 * 1024 * 1024,
			shell: false,
			stdio: ["inherit", "pipe", "pipe"],
		},
	);
	process.stdout.write(result.stdout ?? "");
	process.stderr.write(result.stderr ?? "");
	if (result.error) {
		throw new Error(
			`Unable to start the Node test runner: ${result.error.message}`,
			{
				cause: result.error,
			},
		);
	}
	if (result.status === null) {
		throw new Error(
			`Node test runner terminated without an exit code${result.signal ? ` (${result.signal})` : ""}`,
		);
	}
	if (result.status !== 0) {
		writeGitHubFailureAnnotation(result.stdout ?? "", result.stderr ?? "");
	}
	return result.status;
}

function isDirectEntrypoint() {
	const entrypointPath = process.argv[1];
	return (
		entrypointPath !== undefined &&
		pathToFileURL(realpathSync(path.resolve(entrypointPath))).href ===
			import.meta.url
	);
}

if (isDirectEntrypoint()) {
	try {
		process.exitCode = await runExpectedNodeTests(import.meta.dirname);
	} catch (error) {
		process.stderr.write(
			`Node test runner failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
