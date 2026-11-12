import assert from "node:assert/strict";
import { test } from "node:test";
import {
	admitContext,
	contextRequestDigest,
} from "../../src/modules/llm/context-admission.ts";
import type {
	ContextAuthority,
	ContextRequest,
} from "../../src/modules/llm/context-types.ts";
import { invokeLlm } from "../../src/modules/llm/llm-invoker.ts";
import { syntheticContextAuthority } from "../helpers/context-authority.ts";

const request: ContextRequest = {
	provider: "synthetic",
	model: "snapshot-one",
	protocol: "test-wire-v1",
	providerOptions: undefined,
	request: {
		messages: [
			{ role: "system", content: "system" },
			{ role: "user", content: 'héllo 😀 \\"' },
		],
		maxTokens: 128,
	},
};

test("qualified injected profile admits exact complete request with output reserve", async () => {
	const result = await admitContext(request, syntheticContextAuthority());
	assert.equal(result.status, "ADMITTED");
	assert.equal(result.requestDigest, contextRequestDigest(request));
	assert.equal(result.inputTokens, Buffer.byteLength(JSON.stringify(request)));
	assert.equal(result.responseTokens, 128);
});

test("capacity, expiry, reserve, encoding and provenance independently refuse", async () => {
	for (const [changes, expected] of [
		[{ inputLimit: 1 }, "REJECTED_INPUT_CAPACITY"],
		[{ combinedLimit: 150 }, "REJECTED_INPUT_CAPACITY"],
		[{ expiresAt: 99 }, "CAPABILITY_STALE"],
		[{ qualifiedAt: 101 }, "CAPABILITY_STALE"],
		[{ minimumResponseTokens: 129 }, "REJECTED_OUTPUT_RESERVE"],
		[{ outputLimit: 127 }, "REJECTED_OUTPUT_RESERVE"],
		[{ model: "other" }, "CAPABILITY_UNKNOWN"],
		[{ protocol: "other" }, "COUNTING_UNSUPPORTED"],
		[{ provenance: "" }, "CAPABILITY_UNKNOWN"],
	] as const)
		assert.equal(
			(await admitContext(request, syntheticContextAuthority(changes))).status,
			expected,
		);
});

test("unknown profiles and synthetic profiles at production boundary never admit", async () => {
	assert.equal(
		(
			await admitContext(request, {
				scope: "production",
				now: () => 100,
				resolve: () => undefined,
			})
		).status,
		"CAPABILITY_UNKNOWN",
	);
	const authority = syntheticContextAuthority();
	assert.equal(
		(await admitContext(request, { ...authority, scope: "production" })).status,
		"CAPABILITY_UNKNOWN",
	);
});

test("count binds request, revision, encoding and all protocol overhead", async () => {
	for (const changes of [
		{ requestDigest: "foreign" },
		{ revision: "other" },
		{ encoding: "other" },
		{ includesProtocol: false },
		{ inputTokens: NaN },
	]) {
		const original = syntheticContextAuthority().resolve(request);
		assert.ok(original);
		assert.equal(
			(
				await admitContext(
					request,
					syntheticContextAuthority({
						count: async (r) => ({
							...(await original.count(r, new AbortController().signal)),
							...changes,
						}),
					}),
				)
			).status,
			"COUNTING_UNSUPPORTED",
		);
	}
});

test("feedback or target change requires a new proof; no mutable count input", async () => {
	const before = await admitContext(request, syntheticContextAuthority());
	const after = await admitContext(
		{
			...request,
			model: "smaller",
			request: {
				...request.request,
				messages: [{ role: "user", content: "feedback".repeat(100) }],
			},
		},
		syntheticContextAuthority({ inputLimit: 300 }),
	);
	assert.notEqual(before.requestDigest, after.requestDigest);
	assert.equal(after.status, "REJECTED_INPUT_CAPACITY");
	const malicious: ContextAuthority = syntheticContextAuthority({
		count: async (r) => {
			Object.assign(r.request, { maxTokens: 0 });
			throw new Error("must not mutate request");
		},
	});
	assert.equal(
		(await admitContext(request, malicious)).status,
		"COUNTING_UNSUPPORTED",
	);
	assert.equal(request.request.maxTokens, 128);
});

test("real invoker refuses unqualified production model before adapter generation", async () => {
	await assert.rejects(
		invokeLlm({
			provider: "unqualified-provider",
			model: "dynamic-latest",
			token: "synthetic",
			temperature: 0,
			systemPrompt: "system",
			userPrompt: "user",
		}),
		/CAPABILITY_UNKNOWN/,
	);
});

test("counter deadline aborts an unresolved count without admitting or retrying", async () => {
	let calls = 0;
	let aborted = false;
	const authority = syntheticContextAuthority({
		count: async (_request, signal) => {
			calls++;
			signal.addEventListener(
				"abort",
				() => {
					aborted = true;
				},
				{ once: true },
			);
			return new Promise(() => {});
		},
	});
	const result = await admitContext(request, {
		...authority,
		countTimeoutMilliseconds: 5,
	});
	assert.equal(result.status, "COUNTING_UNSUPPORTED");
	assert.equal(calls, 1);
	assert.equal(aborted, true);
});

test("clock and serialization failures refuse without leaking counter diagnostics", async () => {
	const authority = syntheticContextAuthority();
	assert.equal(
		(
			await admitContext(request, {
				...authority,
				now: () => {
					throw new Error("private diagnostic");
				},
			})
		).status,
		"CAPABILITY_STALE",
	);
	const cyclic = { ...request, providerOptions: {} as Record<string, unknown> };
	cyclic.providerOptions.self = cyclic;
	assert.equal(
		(await admitContext(cyclic, authority)).status,
		"COUNTING_UNSUPPORTED",
	);
});
