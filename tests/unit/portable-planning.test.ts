import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildSimplePrompt,
	createOpenAICompatibleAdapter,
} from "@fanilosendrison/llm-runtime";
import { executeMultiCommitAndPush } from "../../src/modules/git/publisher.ts";
import { productionContextAuthority } from "../../src/modules/llm/context-admission.ts";
import {
	invokeLlm,
	type LlmAdapterFactories,
} from "../../src/modules/llm/llm-invoker.ts";
import { PlanningAttemptBudget } from "../../src/modules/llm/planning-attempt-budget.ts";
import { executePlanningJob } from "../../src/modules/planning/planning-job.ts";
import {
	fixture,
	fixtureBridge,
	git,
	settings,
} from "../fixtures/context-planning.ts";

function runtime(fetch: typeof globalThis.fetch): typeof invokeLlm {
	const unexpected = () => {
		throw new Error("unexpected provider");
	};
	const factories: LlmAdapterFactories = {
		buildSimplePrompt,
		createOpenAICompatibleAdapter,
		createGoogleAdapter: unexpected,
		createOpenAIAdapter: unexpected,
		createAnthropicAdapter: unexpected,
		fetch,
	};
	return (payload, _unused, budget) => invokeLlm(payload, factories, budget);
}
function answer(paths: string[]) {
	return new Response(
		JSON.stringify({
			choices: [
				{
					message: {
						content: JSON.stringify([
							{
								commit: {
									type: "fix",
									description: "preserve changes",
									isBreaking: false,
								},
								files: paths,
							},
						]),
					},
					finish_reason: "stop",
				},
			],
		}),
		{ status: 200 },
	);
}
function wire(options?: RequestInit) {
	assert.equal(typeof options?.body, "string");
	return JSON.parse(options?.body as string) as {
		model: string;
		max_tokens: number;
		messages: { role: string; content: string }[];
	};
}
function members(options?: RequestInit): string[] {
	const body = wire(options);
	assert.equal(body.max_tokens, 4096);
	const user = body.messages.find((m) => m.role === "user")?.content ?? "";
	return JSON.parse(
		user.split("\n")[0]?.slice("AUTHORITATIVE_PARTITION ".length) ?? "",
	).paths;
}

test("portable runtime sends an explicit reserve without an official counter", async () => {
	let calls = 0;
	const invoke = runtime(async (_url, options) => {
		calls++;
		assert.equal(wire(options).max_tokens, 4096);
		return answer(["a"]);
	});
	const response = await invoke({
		provider: "mistral",
		model: "small-latest",
		token: "synthetic",
		temperature: 0,
		systemPrompt: "system",
		userPrompt: "small",
	});
	assert.equal(calls, 1);
	assert.equal(JSON.parse(response)[0].files[0], "a");
});

test("portable complete-request bound includes system and feedback, without transport", async () => {
	let calls = 0;
	const invoke = runtime(async () => {
		calls++;
		return answer(["a"]);
	});
	await assert.rejects(
		invoke({
			provider: "mistral",
			model: "small",
			token: "synthetic",
			temperature: 0,
			systemPrompt: "é".repeat(32768),
			userPrompt: "small",
		}),
		/PORTABLE_REQUEST_LIMIT/,
	);
	assert.equal(calls, 0);
});

test("structured Mistral overflow bisects complete Git units and never publishes partial plans", async () => {
	const f = await fixture();
	try {
		const calls: string[][] = [];
		const invoke = runtime(async (_url, options) => {
			const paths = members(options);
			calls.push(paths);
			assert.equal(git(f.repo.dir, "rev-parse", "HEAD"), f.head);
			assert.equal(git(f.remote, "rev-parse", "HEAD"), f.head);
			if (paths.length > 2)
				return new Response(
					JSON.stringify({
						code: "invalid_request_prompt_too_long",
						prompt_tokens: 264308,
						context_limit: 262144,
						message: "untrusted diagnostic",
					}),
					{ status: 400 },
				);
			return answer(paths);
		});
		const plans = await executePlanningJob(
			{
				...f.payload,
				planningSource: {
					...(f.payload.planningSource ?? assert.fail("source required")),
					maxDiffChars: 100000,
				},
			},
			"synthetic",
			invoke,
		);
		assert.deepEqual(
			plans.flatMap((p) => p.files).sort(),
			[...f.validated.validatedSource.expectedChangedPaths].sort(),
		);
		assert.equal(calls.length, 7);
		assert.equal(calls[0]?.length, 6);
		assert(calls.slice(1).every((p) => p.length < 6));
	} finally {
		f.dispose();
	}
});

for (const body of [
	{ message: "invalid_request_prompt_too_long context token too long" },
	{ error: { message: '{"code":"invalid_request_prompt_too_long"}' } },
	{ code: "invalid_request" },
])
	test(`untrusted error text never authorizes subdivision: ${JSON.stringify(body)}`, async () => {
		const f = await fixture();
		try {
			let calls = 0;
			const invoke = runtime(async () => {
				calls++;
				return new Response(JSON.stringify(body), { status: 400 });
			});
			await assert.rejects(executePlanningJob(f.payload, "synthetic", invoke));
			assert.equal(calls, 1);
			assert.equal(git(f.repo.dir, "rev-parse", "HEAD"), f.head);
		} finally {
			f.dispose();
		}
	});

test("different subdivisions change proposed grouping, not Git completeness; portable aggregate publishes exact T", async () => {
	const f = await fixture();
	try {
		const broad = {
			...f.payload,
			planningSource: {
				...(f.payload.planningSource ?? assert.fail("source required")),
				maxDiffChars: 100000,
			},
		};
		const invoke = runtime(async (_url, options) => answer(members(options)));
		const together = await executePlanningJob(broad, "synthetic", invoke);
		const separated = await executePlanningJob(f.payload, "synthetic", invoke);
		assert.equal(together.length, 1);
		assert(separated.length > 1);
		assert.deepEqual(
			together.flatMap((p) => p.files).sort(),
			separated.flatMap((p) => p.files).sort(),
		);
		// This oracle proves exact source/remote identity, not semantic equivalence of groups.
		await executeMultiCommitAndPush(
			f.repo.dir,
			separated,
			f.validated.diffHash,
			settings,
			undefined,
			{ witness: f.validated.validatedSource },
		);
		assert.equal(
			git(f.repo.dir, "rev-parse", "HEAD^{tree}"),
			f.validated.validatedSource.expectedTreeSha,
		);
		assert.equal(
			git(f.remote, "rev-parse", "HEAD"),
			git(f.repo.dir, "rev-parse", "HEAD"),
		);
	} finally {
		f.dispose();
	}
});

test("overflow consumes the last permitted call and cannot start a fresh budget for subdivision", async () => {
	const f = await fixture();
	try {
		let sends = 0;
		const invoke = runtime(async () => {
			sends++;
			return new Response(
				JSON.stringify({ code: "invalid_request_prompt_too_long" }),
				{ status: 400 },
			);
		});
		const budget = new PlanningAttemptBudget({
			calls: 63,
			recoveries: 4,
			malformed: 1,
			proofs: 0,
		});
		await assert.rejects(
			executePlanningJob(
				{
					...f.payload,
					planningSource: {
						...(f.payload.planningSource ?? assert.fail("source required")),
						maxDiffChars: 100000,
					},
				},
				"synthetic",
				invoke,
				undefined,
				budget,
			),
			/budget exhausted/,
		);
		assert.equal(sends, 1);
		assert.equal(budget.snapshot().calls, 64);
		assert.equal(git(f.repo.dir, "rev-parse", "HEAD"), f.head);
		assert.equal(git(f.remote, "rev-parse", "HEAD"), f.head);
	} finally {
		f.dispose();
	}
});

test("terminal overflow evidence and reason survive the actual bridge and result schema without diagnostics", async () => {
	const f = await fixture();
	try {
		const invoke = runtime(
			async () =>
				new Response(
					JSON.stringify({
						code: "invalid_request_prompt_too_long",
						message: "PRIVATE_PROVIDER_DIAGNOSTIC",
					}),
					{ status: 400 },
				),
		);
		const result = await fixtureBridge(f, {
			invoke,
			authority: productionContextAuthority,
			calls: [],
		});
		assert.equal(result.success, false);
		assert.ok("contextOverflow" in result);
		const evidence = result.contextOverflow as Record<string, unknown>;
		assert.equal(evidence.status, "CONTEXT_OVERFLOW_REPORTED");
		assert.equal(evidence.provider, "mistral");
		assert.equal(evidence.model, f.payload.model);
		assert.equal(evidence.providerCode, "invalid_request_prompt_too_long");
		assert.equal(evidence.httpStatus, 400);
		assert.equal(evidence.reason, "indivisible-path");
		assert.match(String(evidence.requestDigest), /^[a-f0-9]{64}$/);
		assert.ok(!JSON.stringify(result).includes("PRIVATE_PROVIDER_DIAGNOSTIC"));
		assert.equal(git(f.remote, "rev-parse", "HEAD"), f.head);
	} finally {
		f.dispose();
	}
});

test("an indivisible structured overflow terminates with exact source and remote preserved", async () => {
	const f = await fixture();
	try {
		let calls = 0;
		const invoke = runtime(async () => {
			calls++;
			return new Response(
				JSON.stringify({
					code: "invalid_request_prompt_too_long",
				}),
				{ status: 400 },
			);
		});
		await assert.rejects(
			executePlanningJob(f.payload, "synthetic", invoke),
			/indivisible/,
		);
		assert(calls > 0 && calls <= 6);
		assert.equal(git(f.repo.dir, "rev-parse", "HEAD"), f.head);
		assert.equal(git(f.remote, "rev-parse", "HEAD"), f.head);
	} finally {
		f.dispose();
	}
});
