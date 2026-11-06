import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInvocationArguments } from "../../src/modules/invocation/invocation-scope.ts";
import { classifyPublicInvocationMode } from "../../src/modules/reconciliation/classify-public-invocation.ts";

const targeted = [
	"--repository",
	"/not-accessed",
	"--push-remote",
	"origin",
	"--push-ref",
	"refs/heads/task",
];
const create = [
	"--create-if-absent",
	"--base-ref",
	"refs/heads/main",
	"--base-sha",
	"a".repeat(40),
];
test("C02 | creation parsing is pure and consumes the complete authority group", () => {
	assert.equal(
		classifyPublicInvocationMode([...targeted, ...create]),
		"targeted",
	);
	assert.equal(classifyPublicInvocationMode(targeted), "targeted");
	assert.equal(classifyPublicInvocationMode([]), "targeted");
	assert.deepEqual(
		parseInvocationArguments([...targeted, ...create, "--run-id", "opaque"]),
		{
			request: {
				kind: "targeted-create",
				repository: "/not-accessed",
				pushRemote: "origin",
				pushRef: "refs/heads/task",
				baseRef: "refs/heads/main",
				baseSha: "a".repeat(40),
			},
			passthroughArguments: ["--run-id", "opaque"],
		},
	);
});
test("C03 | incomplete, duplicate, valued boolean, equals and resume forms fail", () => {
	const rejected = [
		[...create],
		[...targeted, "--create-if-absent"],
		[
			...targeted,
			"--base-ref",
			"refs/heads/main",
			"--base-sha",
			"a".repeat(40),
		],
		[...targeted, ...create, "--base-ref", "refs/heads/main"],
		[...targeted, ...create, "--create-if-absent"],
		[...targeted, "--create-if-absent", "true", ...create.slice(1)],
		[...targeted, ...create, "--resume"],
		[...targeted, ...create, "--resume=run"],
		[...targeted, ...create.slice(0, -1)],
	];
	for (const flag of ["--create-if-absent", "--base-ref", "--base-sha"])
		rejected.push([...targeted, ...create, `${flag}=value`]);
	for (const args of rejected)
		assert.throws(
			() => parseInvocationArguments(args),
			Error,
			JSON.stringify(args),
		);
});
