import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const FIXED_TEST_TIMEOUT_MILLISECONDS = 30_000;
export const EXPECTED_NODE_TEST_FILES = Object.freeze([
	"test/copy-assets.test.ts",
	"test/parse-yaml.test.ts",
	"test/run-process.test.ts",
	"test/test-runner.test.mjs",
]);

export async function resolveExpectedTestFiles(
	packageDirectory,
	expectedTestFiles,
) {
	if (expectedTestFiles.length === 0) {
		throw new Error("Expected Node test-file set must not be empty");
	}

	const absolutePackageDirectory = path.resolve(packageDirectory);
	const resolvedTestFiles = [];
	for (const expectedTestFile of expectedTestFiles) {
		const absoluteTestFile = path.resolve(
			absolutePackageDirectory,
			expectedTestFile,
		);
		const relativeTestFile = path.relative(
			absolutePackageDirectory,
			absoluteTestFile,
		);
		const escapesPackage =
			relativeTestFile === ".." ||
			relativeTestFile.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relativeTestFile);
		if (relativeTestFile.length === 0 || escapesPackage) {
			throw new Error(
				`Expected Node test path must stay inside the package: ${JSON.stringify(expectedTestFile)}`,
			);
		}

		try {
			const testFileStats = await stat(absoluteTestFile);
			if (!testFileStats.isFile()) {
				throw new Error("path is not a regular file");
			}
		} catch (cause) {
			throw new Error(
				`Expected Node test file is missing or invalid: ${JSON.stringify(expectedTestFile)}`,
				{ cause },
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

export async function runExpectedNodeTests(packageDirectory) {
	const resolvedTestFiles = await resolveExpectedTestFiles(
		packageDirectory,
		EXPECTED_NODE_TEST_FILES,
	);
	const result = spawnSync(
		process.execPath,
		buildNodeTestArguments(resolvedTestFiles),
		{
			cwd: packageDirectory,
			env: process.env,
			stdio: "inherit",
		},
	);
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
	return result.status;
}

function isDirectEntrypoint() {
	const entrypointPath = process.argv[1];
	return (
		entrypointPath !== undefined &&
		pathToFileURL(path.resolve(entrypointPath)).href === import.meta.url
	);
}

if (isDirectEntrypoint()) {
	try {
		process.exitCode = await runExpectedNodeTests(
			path.resolve(import.meta.dirname, ".."),
		);
	} catch (error) {
		process.stderr.write(
			`Node test runner failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
