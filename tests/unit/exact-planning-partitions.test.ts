import assert from "node:assert/strict";
import { test } from "node:test";
import { admitContext } from "../../src/modules/llm/context-admission.ts";
import { buildContextRequest } from "../../src/modules/llm/context-request.ts";
import {
	MAX_CONTEXT_PROOFS,
	PlanningAttemptBudget,
} from "../../src/modules/llm/planning-attempt-budget.ts";
import {
	assertExactPlanningCoverage,
	partitionPlanningPaths,
} from "../../src/modules/planning/exact-partitions.ts";
import type { PlanningPartition } from "../../src/modules/planning/planning-types.ts";
import { syntheticContextAuthority } from "../helpers/context-authority.ts";

const requestFor = (p: PlanningPartition) =>
	buildContextRequest({
		provider: "synthetic",
		model: "snapshot",
		token: "unused",
		temperature: 0,
		systemPrompt: "system",
		userPrompt: JSON.stringify(p),
		responseReserve: 128,
	});
const plan = (files: string[]) => ({
	commit: {
		type: "test",
		description: "preserve exact source",
		isBreaking: false,
	},
	files,
});

test("deterministic closed partitions use full individual representations and exact paths", async () => {
	const inputs = ["z file", 'a\nquoted"', "binary"].map((path) => ({
		path,
		patch: path + "x".repeat(100),
	}));
	const a = await partitionPlanningPaths(
		inputs,
		requestFor,
		syntheticContextAuthority(),
		150,
	);
	const b = await partitionPlanningPaths(
		[...inputs].reverse(),
		requestFor,
		syntheticContextAuthority(),
		150,
	);
	assert.deepEqual(a, b);
	assert.equal(a.length, 3);
	assert.deepEqual(
		a.flatMap((p) => p.paths).sort(),
		inputs.map((p) => p.path).sort(),
	);
	for (const input of inputs)
		assert(
			a.some(
				(p) => p.paths.includes(input.path) && p.diff.includes(input.patch),
			),
		);
});

test("input capacity causes partitions; stale, unknown and oversized indivisible paths refuse", async () => {
	const inputs = ["a", "b"].map((path) => ({ path, patch: "x".repeat(180) }));
	const singleSize = Buffer.byteLength(
		JSON.stringify(requestFor({ paths: ["a"], diff: inputs[0]?.patch ?? "" })),
	);
	const parts = await partitionPlanningPaths(
		inputs,
		requestFor,
		syntheticContextAuthority({ inputLimit: singleSize + 10 }),
		10000,
	);
	assert.equal(parts.length, 2);
	await assert.rejects(
		partitionPlanningPaths(
			inputs,
			requestFor,
			syntheticContextAuthority({ inputLimit: 1 }),
			10000,
		),
		/indivisible|REJECTED_INPUT_CAPACITY/,
	);
	await assert.rejects(
		partitionPlanningPaths(
			inputs,
			requestFor,
			syntheticContextAuthority({ expiresAt: 1 }),
			10000,
		),
		/CAPABILITY_STALE/,
	);
	await assert.rejects(
		partitionPlanningPaths(
			inputs,
			requestFor,
			{ scope: "production", now: () => 100, resolve: () => undefined },
			10000,
		),
		/CAPABILITY_UNKNOWN/,
	);
});

test("duplicate, omitted and invented paths cannot authorize an aggregate", () => {
	assert.doesNotThrow(() =>
		assertExactPlanningCoverage([plan(["a"]), plan(["b"])], ["a", "b"]),
	);
	for (const plans of [
		[plan(["a"])],
		[plan(["a", "b", "c"])],
		[plan(["a", "a", "b"])],
		[],
	])
		assert.throws(
			() => assertExactPlanningCoverage(plans, ["a", "b"]),
			/coverage|membership|duplicate/i,
		);
});

test("duplicate inputs and excessive partition counts refuse", async () => {
	await assert.rejects(
		partitionPlanningPaths(
			[
				{ path: "a", patch: "x" },
				{ path: "a", patch: "y" },
			],
			requestFor,
			syntheticContextAuthority(),
			1,
		),
		/duplicate/i,
	);
	await assert.rejects(
		partitionPlanningPaths(
			Array.from({ length: 33 }, (_, i) => ({ path: String(i), patch: "x" })),
			requestFor,
			syntheticContextAuthority(),
			1,
		),
		/partition.*bound/i,
	);
});

test("one shared recovery pool and one malformed repeat cover all partition calls", () => {
	const budget = new PlanningAttemptBudget();
	assert.equal(budget.beginCall(), 5);
	budget.chargeTransport(4);
	assert.equal(budget.beginCall(), 2);
	budget.chargeTransport(2);
	assert.equal(budget.beginCall(), 1);
	assert.throws(() => budget.chargeTransport(2), /attempt evidence/);
	assert.equal(budget.repeatMalformed(), true);
	assert.equal(budget.repeatMalformed(), false);
	assert.deepEqual(budget.snapshot(), {
		calls: 3,
		recoveries: 4,
		malformed: 1,
		proofs: 0,
	});
});

test("all partition/admission counter requests share a finite proof allowance", async () => {
	const budget = new PlanningAttemptBudget();
	const authority = budget.boundAuthority(syntheticContextAuthority());
	assert.equal(budget.boundAuthority(authority), authority);
	const request = requestFor({ paths: ["a"], diff: "a" });
	for (let n = 0; n < MAX_CONTEXT_PROOFS; n++)
		assert.equal((await admitContext(request, authority)).status, "ADMITTED");
	assert.equal(
		(await admitContext(request, authority)).status,
		"COUNTING_UNSUPPORTED",
	);
	assert.equal(budget.snapshot().proofs, MAX_CONTEXT_PROOFS);
});
