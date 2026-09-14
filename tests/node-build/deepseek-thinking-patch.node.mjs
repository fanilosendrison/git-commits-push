/**
 * Deterministic verification that the compiled invoker and the installed
 * (patched) @fanilosendrison/llm-runtime apply the DeepSeek thinking-mode and
 * response-body timeout fixes.
 *
 * The dependency is patched transitionally until llm-runtime 0.1.4 is
 * published; this test fails if the patch stops being applied or stops
 * matching the compiled invoker contract.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	createOpenAICompatibleAdapter,
	TimeoutError,
} from "@fanilosendrison/llm-runtime";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "../..");
const invokerPath = path.join(
	skillDirectory,
	"dist",
	"src",
	"modules",
	"llm",
	"llm-invoker.js",
);

const COMPLETION_BODY = {
	id: "chatcmpl-patch-check",
	model: "deepseek-flash",
	choices: [
		{
			index: 0,
			message: { role: "assistant", content: "OK" },
			finish_reason: "stop",
		},
	],
	usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
};

function jsonResponseCapture(body = COMPLETION_BODY) {
	const state = { body: undefined };
	const fetchImpl = async (_url, init) => {
		state.body = JSON.parse(init.body);
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { state, fetchImpl };
}

test("compiled invoker forwards explicit DeepSeek thinking provider options", async () => {
	const { invokeLlm } = await import(pathToFileURL(invokerPath).href);
	const invocations = [];
	const stub = (config) => ({
		call: async (request) => {
			invocations.push({ config, request });
			return { content: "OK" };
		},
	});
	const factories = {
		buildSimplePrompt: (prompt) => prompt,
		createAnthropicAdapter: stub,
		createGoogleAdapter: stub,
		createOpenAIAdapter: stub,
		createOpenAICompatibleAdapter: stub,
	};
	const payload = {
		provider: "deepseek",
		model: "deepseek-flash",
		token: "token",
		temperature: 0.2,
		systemPrompt: "sys",
		userPrompt: "user",
	};

	await invokeLlm({ ...payload, thinking: false }, factories);
	await invokeLlm({ ...payload, thinking: true }, factories);

	assert.deepEqual(invocations[0].config.providerOptions, {
		thinking: { type: "disabled" },
	});
	assert.deepEqual(invocations[1].config.providerOptions, {
		thinking: { type: "enabled", reasoningEffort: "high" },
	});
});

test("patched runtime serializes explicit DeepSeek disabled thinking", async () => {
	const { state, fetchImpl } = jsonResponseCapture();
	const adapter = createOpenAICompatibleAdapter({
		provider: "deepseek",
		model: "deepseek-flash",
		apiKey: "key",
		sanitization: {},
		providerOptions: { thinking: { type: "disabled" }, fetch: fetchImpl },
	});

	await adapter.call({ messages: [{ role: "user", content: "hi" }] });

	assert.deepEqual(state.body.thinking, { type: "disabled" });
	assert.equal(state.body.reasoning_effort, undefined);
});

test("patched runtime keeps the DeepSeek option out of other providers", async () => {
	const { state, fetchImpl } = jsonResponseCapture({
		...COMPLETION_BODY,
		model: "mistral-large-latest",
	});
	const adapter = createOpenAICompatibleAdapter({
		provider: "mistral",
		model: "mistral-large-latest",
		apiKey: "key",
		sanitization: {},
		providerOptions: { thinking: { type: "disabled" }, fetch: fetchImpl },
	});

	await adapter.call({ messages: [{ role: "user", content: "hi" }] });

	assert.equal(state.body.thinking, undefined);
	assert.equal(state.body.reasoning_effort, undefined);
});

test("patched runtime bounds a stalled response body by the attempt timeout", async () => {
	const adapter = createOpenAICompatibleAdapter({
		provider: "deepseek",
		model: "deepseek-flash",
		apiKey: "key",
		sanitization: {},
		retry: { maxAttempts: 1, backoffBaseMs: 0, maxBackoffMs: 0 },
		timeout: { perAttemptMs: 60 },
		providerOptions: {
			fetch: async (_url, init) => {
				const signal = init.signal;
				const stream = new ReadableStream({
					start(controller) {
						if (!signal) return;
						const abort = () => controller.error(signal.reason);
						signal.addEventListener("abort", abort, { once: true });
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		},
	});
	const startedAt = Date.now();

	await assert.rejects(
		adapter.call({ messages: [{ role: "user", content: "hi" }] }),
		(error) => error instanceof TimeoutError && error.timeoutMs === 60,
	);
	assert.ok(Date.now() - startedAt < 1500);
});
