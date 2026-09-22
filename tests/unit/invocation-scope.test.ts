// tests/unit/invocation-scope.test.ts — Unit tests for the pure invocation-scope
// argument parser.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseInvocationArguments } from "../../src/modules/invocation/invocation-scope.ts";

describe("U-IS-01 | global parser", () => {
	test("returns a global request and preserves passthrough arguments", () => {
		const parsed = parseInvocationArguments(["--run-id", "abc"]);

		assert.deepStrictEqual(parsed.request, { kind: "global" });
		assert.deepStrictEqual(
			[...parsed.passthroughArguments],
			["--run-id", "abc"],
		);
	});
});

describe("U-IS-02 | complete targeted parser", () => {
	test("extracts the three raw values and preserves unrelated order", () => {
		const parsed = parseInvocationArguments([
			"--run-id",
			"abc",
			"--repository",
			"/absolute/repo",
			"--push-remote",
			"origin",
			"--push-ref",
			"refs/heads/main",
		]);

		assert.deepStrictEqual(parsed.request, {
			kind: "targeted",
			repository: "/absolute/repo",
			pushRemote: "origin",
			pushRef: "refs/heads/main",
		});
		assert.deepStrictEqual(
			[...parsed.passthroughArguments],
			["--run-id", "abc"],
		);
	});

	test("preserves interleaved passthrough ordering", () => {
		const parsed = parseInvocationArguments([
			"--run-id",
			"abc",
			"--repository",
			"/absolute/repo",
			"--label",
			"batch",
			"--push-remote",
			"origin",
			"--push-ref",
			"refs/heads/main",
		]);

		assert.deepStrictEqual(
			[...parsed.passthroughArguments],
			["--run-id", "abc", "--label", "batch"],
		);
	});
});

describe("U-IS-03 | atomic targeted group", () => {
	const incompleteCases: readonly (readonly string[])[] = [
		["--repository", "/absolute/repo"],
		["--push-remote", "origin"],
		["--push-ref", "refs/heads/main"],
		["--repository", "/absolute/repo", "--push-remote", "origin"],
		["--repository", "/absolute/repo", "--push-ref", "refs/heads/main"],
		["--push-remote", "origin", "--push-ref", "refs/heads/main"],
	];

	for (const args of incompleteCases) {
		test(`rejects incomplete group: ${args.join(" ")}`, () => {
			assert.throws(
				() => parseInvocationArguments(args),
				/all three flags together/,
			);
		});
	}
});

describe("U-IS-04 | duplicate targeted flags", () => {
	test("rejects each duplicated owned flag", () => {
		assert.throws(
			() =>
				parseInvocationArguments([
					"--repository",
					"/a",
					"--repository",
					"/b",
					"--push-remote",
					"origin",
					"--push-ref",
					"refs/heads/main",
				]),
			/Duplicate targeted invocation flag: --repository/,
		);
		assert.throws(
			() =>
				parseInvocationArguments([
					"--repository",
					"/a",
					"--push-remote",
					"origin",
					"--push-remote",
					"upstream",
					"--push-ref",
					"refs/heads/main",
				]),
			/Duplicate targeted invocation flag: --push-remote/,
		);
		assert.throws(
			() =>
				parseInvocationArguments([
					"--repository",
					"/a",
					"--push-remote",
					"origin",
					"--push-ref",
					"refs/heads/main",
					"--push-ref",
					"refs/heads/dev",
				]),
			/Duplicate targeted invocation flag: --push-ref/,
		);
	});
});

describe("U-IS-05 | equals syntax", () => {
	test("rejects --flag=value for each owned flag", () => {
		for (const argument of [
			"--repository=/x",
			"--push-remote=origin",
			"--push-ref=refs/heads/main",
		]) {
			assert.throws(
				() => parseInvocationArguments([argument]),
				/does not accept --flag=value syntax/,
			);
		}
	});
});

describe("U-IS-06 | resume", () => {
	test("rejects targeted flags combined with --resume", () => {
		assert.throws(
			() =>
				parseInvocationArguments([
					"--resume",
					"--repository",
					"/absolute/repo",
					"--push-remote",
					"origin",
					"--push-ref",
					"refs/heads/main",
				]),
			/resume uses the persisted invocation scope/,
		);
	});

	test("passes global resume arguments through unchanged", () => {
		const parsed = parseInvocationArguments(["--resume", "--run-id", "X"]);

		assert.deepStrictEqual(parsed.request, { kind: "global" });
		assert.deepStrictEqual(
			[...parsed.passthroughArguments],
			["--resume", "--run-id", "X"],
		);
	});
});
