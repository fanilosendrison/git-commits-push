import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { commitJobResultSchema } from "../../src/config/state-schema.ts";
import { productionContextAuthority } from "../../src/modules/llm/context-admission.ts";
import { createContextDispatch } from "../../src/modules/llm/context-dispatch.ts";
import { authorizeContextExecution } from "../../src/modules/llm/context-execution.ts";
import {
	classifyContextOverflow,
	inspectContextOverflow,
} from "../../src/modules/llm/context-overflow.ts";
import { buildContextRequest } from "../../src/modules/llm/context-request.ts";
import {
	acceptPlanningBudget,
	PlanningAttemptBudget,
} from "../../src/modules/llm/planning-attempt-budget.ts";
import { syntheticContextAuthority } from "../helpers/context-authority.ts";

const payload = {
	provider: "mistral",
	model: "snapshot",
	token: "unused",
	temperature: 0,
	systemPrompt: "system",
	userPrompt: "small",
	responseReserve: 128,
};
const request = buildContextRequest(payload);

test("portable receipt never asserts capacity, tokens counted, or semantic coherence", async () => {
	const portable = await authorizeContextExecution(
		request,
		productionContextAuthority,
	);
	assert.equal(portable.status, "PORTABLE_ATTEMPT_ALLOWED");
	assert.equal("proof" in portable, false);
	assert.equal("inputTokens" in portable, false);
	assert.equal("semanticCoherence" in portable, false);
	const qualified = await authorizeContextExecution(
		request,
		syntheticContextAuthority(),
	);
	assert.equal(qualified.status, "CONTEXT_CAPACITY_PROVEN");
	assert.notEqual(qualified.requestDigest, "");
	assert.equal(portable.requestDigest, qualified.requestDigest);
});

test("model, feedback, options and reserve changes rebuild the complete identity", async () => {
	const decisions = await Promise.all(
		[
			payload,
			{ ...payload, model: "another" },
			{ ...payload, userPrompt: "small + feedback" },
			{ ...payload, thinking: true },
			{ ...payload, responseReserve: 256 },
		].map((p) =>
			authorizeContextExecution(
				buildContextRequest(p),
				productionContextAuthority,
			),
		),
	);
	assert.equal(new Set(decisions.map((d) => d.requestDigest)).size, 5);
});

test("logical bytes include escaping and Unicode; exact boundary and output limits refuse independently", async () => {
	const base = buildContextRequest({ ...payload, userPrompt: "x" });
	const overhead = Buffer.byteLength(JSON.stringify(base)) - 1;
	await authorizeContextExecution(
		buildContextRequest({
			...payload,
			userPrompt: "x".repeat(65536 - overhead),
		}),
		productionContextAuthority,
	);
	await assert.rejects(
		authorizeContextExecution(
			buildContextRequest({
				...payload,
				userPrompt: "x".repeat(65537 - overhead),
			}),
			productionContextAuthority,
		),
		/PORTABLE_REQUEST_LIMIT/,
	);
	await assert.rejects(
		authorizeContextExecution(
			buildContextRequest({ ...payload, userPrompt: "é".repeat(32768) }),
			productionContextAuthority,
		),
		/PORTABLE_REQUEST_LIMIT/,
	);
	for (const responseReserve of [0, 4097, NaN, Infinity, 1.5])
		await assert.rejects(
			authorizeContextExecution(
				buildContextRequest({ ...payload, responseReserve }),
				productionContextAuthority,
			),
			/PORTABLE_OUTPUT_LIMIT/,
		);
});

test("wire limit is enforced on each physical send, never bypassed by a small logical request", async () => {
	let sends = 0;
	const decision = await authorizeContextExecution(
		request,
		productionContextAuthority,
	);
	const dispatch = createContextDispatch(
		request,
		decision,
		productionContextAuthority,
		async () => {
			sends++;
			return new Response("OK");
		},
	);
	await dispatch.fetch("https://invalid.example", { body: "x".repeat(131072) });
	await assert.rejects(
		dispatch.fetch("https://invalid.example", { body: "x".repeat(131073) }),
		/PORTABLE_WIRE_LIMIT/,
	);
	assert.equal(sends, 1);
});

test("selected invalid or stale qualified profiles do not silently downgrade to portable", async () => {
	await assert.rejects(
		authorizeContextExecution(
			request,
			syntheticContextAuthority({ expiresAt: 1 }),
		),
		/CAPABILITY_STALE/,
	);
	await assert.rejects(
		authorizeContextExecution(
			request,
			syntheticContextAuthority({ inputLimit: 1 }),
		),
		/REJECTED_INPUT_CAPACITY/,
	);
});

test("overflow whitelist binds exact provider, status and JSON field, never message substrings", async () => {
	const digest = "a".repeat(64);
	assert.equal(
		classifyContextOverflow(request, digest, 400, {
			code: "invalid_request_prompt_too_long",
		})?.status,
		"CONTEXT_OVERFLOW_REPORTED",
	);
	for (const [provider, status, body] of [
		["google", 400, { code: "invalid_request_prompt_too_long" }],
		["mistral", 401, { code: "invalid_request_prompt_too_long" }],
		["mistral", 429, { code: "invalid_request_prompt_too_long" }],
		["mistral", 400, { message: 'code="invalid_request_prompt_too_long"' }],
		[
			"mistral",
			400,
			{ code: "invalid_request_prompt_too_long", error: { code: "auth" } },
		],
	] as const)
		assert.equal(
			classifyContextOverflow({ ...request, provider }, digest, status, body),
			undefined,
		);
	assert.equal(
		await inspectContextOverflow(
			request,
			digest,
			new Response(
				JSON.stringify({
					code: "invalid_request_prompt_too_long",
					padding: "x".repeat(16384),
				}),
				{ status: 400 },
			),
		),
		undefined,
	);
});

test("settled budget survives model switches, retries, malformed output and schema boundaries", () => {
	const prior = { calls: 63, recoveries: 4, malformed: 1, proofs: 2048 };
	const parsed = commitJobResultSchema.parse({
		success: true,
		id: "job",
		commits: [],
		planningBudget: prior,
	});
	const budget = new PlanningAttemptBudget(
		acceptPlanningBudget(prior, parsed.planningBudget),
	);
	assert.equal(budget.beginCall(), 1);
	budget.chargeTransport(1);
	assert.throws(() => budget.beginCall(), /budget exhausted/);
	assert.equal(budget.repeatMalformed(), false);
	assert.throws(() => acceptPlanningBudget(prior, undefined), /Missing/);
	assert.throws(
		() => acceptPlanningBudget(prior, { ...prior, calls: 0 }),
		/regressed/,
	);
	assert.throws(() => new PlanningAttemptBudget({ ...prior, calls: 65 }));
	assert.equal(
		commitJobResultSchema.safeParse({
			success: true,
			id: "job",
			commits: [],
			planningBudget: { ...prior, recoveries: 5 },
		}).success,
		false,
	);
});

test("overflow receipts reject forged codes, raw diagnostics and combined fallback authority", () => {
	const receipt = {
		status: "CONTEXT_OVERFLOW_REPORTED",
		provider: "mistral",
		model: "small",
		requestDigest: "a".repeat(64),
		httpStatus: 400,
		providerCode: "invalid_request_prompt_too_long",
		reason: "planning-budget-exhausted",
	};
	const result = {
		id: "job",
		success: false,
		error: "bounded failure",
		terminalFailureKind: "invalid_request",
		contextOverflow: receipt,
	};
	assert.deepEqual(commitJobResultSchema.parse(result), result);
	for (const contextOverflow of [
		{ ...receipt, provider: "google" },
		{ ...receipt, providerCode: "invalid_request" },
		{ ...receipt, httpStatus: 401 },
		{ ...receipt, message: "PRIVATE_DIAGNOSTIC" },
		{ ...receipt, reason: "retry-again" },
		{ ...receipt, requestDigest: "not-a-digest" },
	])
		assert.equal(
			commitJobResultSchema.safeParse({ ...result, contextOverflow }).success,
			false,
		);
	assert.equal(
		commitJobResultSchema.safeParse({
			...result,
			terminalFailureKind: undefined,
			providerFailureKind: "rate_limit",
		}).success,
		false,
	);
});

test("public contract explicitly excludes #23 caller constraints and semantic proof", () => {
	const spec = readFileSync(
		new URL("../../specs/model-context-planning.md", import.meta.url),
		"utf8",
	);
	assert.match(spec, /not universal semantic coherence/);
	assert.match(spec, /work belongs to #23/);
	assert.match(spec, /GCP cannot validate an absent input/);
});
