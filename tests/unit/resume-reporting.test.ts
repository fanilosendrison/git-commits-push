import assert from "node:assert/strict";
import { test } from "node:test";
import { resumeWithReporting } from "../fixtures/resume-reporting.ts";

const options = { encoding: "utf8" as const, timeout: 5_000 };

test("reporting never masks a failed source process that already emitted a checkpoint name", () => {
	const result = resumeWithReporting(
		process.execPath,
		[
			"-e",
			"process.stdout.write('commit-outcome-1.json');process.stderr.write('original failure');process.exit(7)",
		],
		options,
	);
	assert.equal(result.status, 7);
	assert.equal(result.stdout, "commit-outcome-1.json");
	assert.equal(result.stderr, "original failure");
});

test("reporting never masks the first process's actual timeout", () => {
	const result = resumeWithReporting(
		process.execPath,
		[
			"-e",
			"process.stdout.write('commit-outcome-1.json');setInterval(()=>{},1000)",
		],
		options,
	);
	assert.ok(result.error && "code" in result.error);
	assert.equal(result.error.code, "ETIMEDOUT");
	assert.equal(result.status, null);
	assert.ok(result.signal);
});

test("successful source output without a reporting request stays byte-exact", () => {
	const result = resumeWithReporting(
		process.execPath,
		[
			"-e",
			"process.stdout.write('ordinary output\\n');process.stderr.write('diagnostic\\n')",
		],
		options,
	);
	assert.equal(result.status, 0);
	assert.equal(result.error, undefined);
	assert.equal(result.stdout, "ordinary output\n");
	assert.equal(result.stderr, "diagnostic\n");
});
