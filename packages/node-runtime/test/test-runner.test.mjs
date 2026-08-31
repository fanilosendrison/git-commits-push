import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	buildNodeTestArguments,
	EXPECTED_NODE_TEST_FILES,
	FIXED_TEST_TIMEOUT_MILLISECONDS,
	resolveExpectedTestFiles,
} from "./run-tests.mjs";

async function withTemporaryDirectory(callback) {
	const directory = await mkdtemp(path.join(tmpdir(), "node-test-runner-"));
	try {
		await callback(directory);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

test("uses a closed test-file set that mechanically excludes upstream", () => {
	assert.deepEqual(EXPECTED_NODE_TEST_FILES, [
		"test/copy-assets.test.ts",
		"test/parse-yaml.test.ts",
		"test/run-process.test.ts",
		"test/test-runner.test.mjs",
	]);
	assert.equal(FIXED_TEST_TIMEOUT_MILLISECONDS, 30_000);
});

test("builds a sequential TAP invocation with a fixed timeout", () => {
	const testFiles = [path.resolve("one.test.ts"), path.resolve("two.test.ts")];
	assert.deepEqual(buildNodeTestArguments(testFiles), [
		"--test",
		"--test-concurrency=1",
		"--test-timeout=30000",
		"--test-reporter=tap",
		...testFiles,
	]);
});

test("fails closed when the expected test-file set is empty", async () => {
	await assert.rejects(
		resolveExpectedTestFiles(process.cwd(), []),
		/Expected Node test-file set must not be empty/,
	);
});

test("fails closed when an expected test file is missing or outside the package", async () => {
	await withTemporaryDirectory(async (directory) => {
		await mkdir(path.join(directory, "test"));
		await writeFile(path.join(directory, "test", "present.test.mjs"), "");

		await assert.rejects(
			resolveExpectedTestFiles(directory, ["test/missing.test.mjs"]),
			/Expected Node test file is missing or invalid.*missing\.test\.mjs/,
		);
		await assert.rejects(
			resolveExpectedTestFiles(directory, ["../outside.test.mjs"]),
			/Expected Node test path must stay inside the package/,
		);
	});
});
