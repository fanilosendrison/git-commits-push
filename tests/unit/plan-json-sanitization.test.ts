import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
	buildSimplePrompt,
	createGoogleAdapter,
} from "@fanilosendrison/llm-runtime";
import { ZodError } from "zod";
import { parseCommitJobResponse } from "../../src/modules/core/commit-job-response.ts";
import {
	invokeLlm,
	type LlmAdapterFactories,
} from "../../src/modules/llm/llm-invoker.ts";
import { reportPlanResponseRejection } from "../../src/modules/llm/plan-response-policy.ts";
import { PlanningAttemptBudget } from "../../src/modules/llm/planning-attempt-budget.ts";
import { executePlanningJob } from "../../src/modules/planning/planning-job.ts";
import {
	fixture,
	fixtureBridge,
	transport as fixtureTransport,
	git,
} from "../fixtures/context-planning.ts";
import { syntheticContextAuthority } from "../helpers/context-authority.ts";

const plan = [
	{
		commit: {
			type: "fix",
			body: "<think>context",
			description: "retain this valid description </think>",
		},
		files: ["one.ts"],
	},
];
const payload = {
	repository: "synthetic",
	diff: "synthetic",
	diffHash: "synthetic",
	provider: "google",
	model: "synthetic-snapshot",
	temperature: 0,
	systemPrompt: "Return plans",
	userPrompt: "synthetic",
	token: "synthetic",
};

function transport(responses: string[]) {
	const authority = syntheticContextAuthority();
	let calls = 0;
	const unexpected = () => {
		throw new Error("unexpected provider");
	};
	const factories: LlmAdapterFactories = {
		contextAuthority: authority,
		buildSimplePrompt,
		createGoogleAdapter,
		createAnthropicAdapter: unexpected,
		createOpenAIAdapter: unexpected,
		createOpenAICompatibleAdapter: unexpected,
		fetch: async () => {
			const text = responses[Math.min(calls++, responses.length - 1)];
			return new Response(
				JSON.stringify({
					candidates: [
						{ content: { parts: [{ text }] }, finishReason: "STOP" },
					],
				}),
				{ status: 200 },
			);
		},
	};
	return {
		authority,
		calls: () => calls,
		invoke: ((input, _unused, budget) =>
			invokeLlm(input, factories, budget)) as typeof invokeLlm,
	};
}

test("IR37 exact cross-field counterexample retains JSON bytes and required description", async () => {
	const raw = JSON.stringify(plan);
	const t = transport([raw]);
	const content = await t.invoke(payload);
	assert.equal(content, raw);
	assert.equal(
		parseCommitJobResponse(payload, content)[0]?.commit.description,
		plan[0]?.commit.description,
	);
	assert.equal(t.calls(), 1);
});

test("literal think/thinking tags and permitted JSON fences survive without content repair", async () => {
	for (const body of [
		"<think>literal</think>",
		"<thinking>literal</thinking>",
		"unclosed <think>",
	]) {
		const expected = [{ ...plan[0], commit: { ...plan[0]?.commit, body } }];
		const t = transport(["```json\n" + JSON.stringify(expected) + "\n```"]);
		assert.deepEqual(
			await executePlanningJob(payload, "synthetic", t.invoke, t.authority),
			expected.map((p) => ({
				...p,
				commit: { ...p.commit, isBreaking: false },
			})),
		);
	}
});

test("invalid descriptions and external thinking/non-JSON stop after the existing single repeat", async () => {
	for (const response of [
		JSON.stringify([{ commit: { type: "fix" }, files: ["one.ts"] }]),
		JSON.stringify([
			{ commit: { type: "fix", description: 7 }, files: ["one.ts"] },
		]),
		"<think>PRIVATE_RESPONSE_CANARY</think>" + JSON.stringify(plan),
		"PRIVATE_RESPONSE_CANARY not JSON",
	]) {
		const t = transport([response]);
		await assert.rejects(
			executePlanningJob(payload, "synthetic", t.invoke, t.authority),
		);
		assert.equal(t.calls(), 2);
	}
});

test("valid second response retains two-call budget and absent descriptions are never invented", async () => {
	const t = transport(["[]", JSON.stringify(plan)]);
	const result = await executePlanningJob(
		payload,
		"synthetic",
		t.invoke,
		t.authority,
	);
	assert.equal(result[0]?.commit.description, plan[0]?.commit.description);
	assert.deepEqual(result[0]?.files, ["one.ts"]);
	assert.equal(t.calls(), 2);
});

test("response diagnostics and terminal errors never contain rejected text or issue values", async () => {
	const output: string[] = [];
	const writer = mock.method(
		process.stderr,
		"write",
		(chunk: string | Uint8Array) => {
			output.push(String(chunk));
			return true;
		},
	);
	try {
		const t = transport(["PRIVATE_RESPONSE_CANARY not JSON"]);
		await assert.rejects(
			executePlanningJob(payload, "synthetic", t.invoke, t.authority),
			{ message: "Commit-plan response rejected (json)" },
		);
		const events = output
			.map((line) => JSON.parse(line))
			.filter((event) => event.event === "commit_plan_response_rejected");
		assert.deepEqual(
			events.map((e) => e.attempt),
			[1, 2],
		);
		assert.deepEqual(
			events.map((e) => e.classification),
			["bounded_repeat", "terminal_response_rejection"],
		);
		assert.ok(!output.join("").includes("PRIVATE_RESPONSE_CANARY"));
		output.length = 0;
		reportPlanResponseRejection(
			new ZodError(
				Array.from({ length: 20 }, () => ({
					code: "custom" as const,
					path: ["PRIVATE_RESPONSE_CANARY"],
					message: "PRIVATE_RESPONSE_CANARY",
				})),
			),
			2,
			false,
			true,
		);
		const diagnostic = JSON.parse(output.join(""));
		assert.equal(diagnostic.issues.length, 8);
		assert.deepEqual(diagnostic.issues[0], {
			code: "custom",
			path: ["unrecognized"],
		});
		assert.ok(!output.join("").includes("PRIVATE_RESPONSE_CANARY"));
		assert.deepEqual(diagnostic.sanitization, {
			stripThinkingTags: false,
			stripJsonFence: true,
		});
	} finally {
		writer.mock.restore();
	}
});

test("invalid plan JSON preserves the real source/index and bare remote with no success", async () => {
	const f = await fixture();
	try {
		const index = git(f.repo.dir, "write-tree");
		for (const raw of [
			"<think>PRIVATE_RESPONSE_CANARY</think>" + JSON.stringify(plan),
			JSON.stringify([{ commit: { type: "fix" }, files: ["one.ts"] }]),
		]) {
			const t = transport([raw]);
			const result = await fixtureBridge(
				f,
				{ ...fixtureTransport(f), invoke: t.invoke, authority: t.authority },
				{ ...f.payload, provider: "google" },
			);
			assert.equal(result.success, false);
			assert.ok(!JSON.stringify(result).includes("PRIVATE_RESPONSE_CANARY"));
			assert.equal(t.calls(), 2);
			assert.equal(git(f.repo.dir, "write-tree"), index);
			assert.equal(git(f.repo.dir, "rev-parse", "HEAD"), f.head);
			assert.equal(git(f.remote, "rev-parse", "HEAD"), f.head);
		}
	} finally {
		f.dispose();
	}
});

test("Stage A does not qualify production profiles or dispatch unknown models", async () => {
	const t = transport([JSON.stringify(plan)]);
	await assert.rejects(
		executePlanningJob(payload, "synthetic", t.invoke),
		/CAPABILITY_UNKNOWN/,
	);
	assert.equal(t.calls(), 0);
});

test("real transport shares existing attempt accounting and does not alter explicit fence opt-out", async () => {
	const raw = "```json\n" + JSON.stringify(plan) + "\n```";
	const t = transport([raw]);
	const budget = new PlanningAttemptBudget();
	assert.equal(
		await t.invoke({ ...payload, stripJsonFence: false }, undefined, budget),
		raw,
	);
	assert.equal(budget.snapshot().calls, 1);
	assert.equal(t.calls(), 1);
});
