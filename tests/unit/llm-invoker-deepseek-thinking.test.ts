/**
 * tests/unit/llm-invoker-deepseek-thinking.test.ts — DeepSeek thinking-mode
 * provider options.
 *
 * DeepSeek enables thinking mode at high effort when the request omits the
 * field. The invoker must therefore translate the explicit three-state
 * `thinking` payload into DeepSeek provider options (disabled / enabled+high /
 * omitted) and must not leak that provider-specific option to other providers.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	invokeLlm,
	type LlmAdapterFactories,
} from "../../src/modules/llm/llm-invoker.ts";

interface CapturedInvocation {
	readonly config: Record<string, unknown>;
	readonly request: Record<string, unknown>;
}

type StubAdapter = ReturnType<LlmAdapterFactories["createAnthropicAdapter"]>;

function createAdapterStub(
	config: unknown,
	captured: CapturedInvocation[],
): StubAdapter {
	return {
		call: async (request: unknown) => {
			captured.push({
				config: config as Record<string, unknown>,
				request: request as Record<string, unknown>,
			});
			return { content: "OK" };
		},
	} as unknown as StubAdapter;
}

function createFactories(captured: CapturedInvocation[]): LlmAdapterFactories {
	const stub = (config: unknown): StubAdapter =>
		createAdapterStub(config, captured);
	return {
		buildSimplePrompt: ((prompt: unknown) =>
			prompt) as LlmAdapterFactories["buildSimplePrompt"],
		createAnthropicAdapter:
			stub as LlmAdapterFactories["createAnthropicAdapter"],
		createGoogleAdapter: stub as LlmAdapterFactories["createGoogleAdapter"],
		createOpenAIAdapter: stub as LlmAdapterFactories["createOpenAIAdapter"],
		createOpenAICompatibleAdapter:
			stub as LlmAdapterFactories["createOpenAICompatibleAdapter"],
	};
}

async function invoke(overrides: {
	readonly provider?: string;
	readonly thinking?: boolean;
}): Promise<CapturedInvocation> {
	const captured: CapturedInvocation[] = [];
	const payload = {
		provider: "deepseek",
		model: "deepseek-flash",
		token: "token",
		temperature: 0.2,
		systemPrompt: "sys",
		userPrompt: "user",
		...overrides,
		...(overrides.thinking !== undefined
			? { thinking: overrides.thinking }
			: {}),
	};
	await invokeLlm(payload, createFactories(captured));
	assert.strictEqual(captured.length, 1);
	const invocation = captured[0];
	if (invocation === undefined) throw new Error("adapter was not invoked");
	return invocation;
}

describe("invokeLlm — DeepSeek thinking provider options", () => {
	test("V-INV-01 | thinking=false sends an explicit disabled option", async () => {
		const { config, request } = await invoke({ thinking: false });

		assert.deepStrictEqual(config.providerOptions, {
			thinking: { type: "disabled" },
		});
		assert.strictEqual(request.thinking, undefined);
		assert.strictEqual(request.reasoningEffort, undefined);
	});

	test("V-INV-02 | thinking=true sends enabled with high effort", async () => {
		const { config, request } = await invoke({ thinking: true });

		assert.deepStrictEqual(config.providerOptions, {
			thinking: { type: "enabled", reasoningEffort: "high" },
		});
		assert.strictEqual(request.thinking, undefined);
	});

	test("V-INV-03 | omitted thinking leaves the provider default untouched", async () => {
		const { config } = await invoke({});

		assert.strictEqual(config.providerOptions, undefined);
	});

	test("V-INV-04 | non-DeepSeek OpenAI-compatible providers keep the legacy request flag", async () => {
		const { config, request } = await invoke({
			provider: "mistral",
			thinking: true,
		});

		assert.strictEqual(config.providerOptions, undefined);
		assert.strictEqual(request.thinking, true);
		assert.strictEqual(request.reasoningEffort, "high");
	});

	test("V-INV-05 | first-class providers keep the legacy request flag", async () => {
		for (const provider of ["anthropic", "openai", "google"] as const) {
			const { config, request } = await invoke({ provider, thinking: true });

			assert.strictEqual(config.providerOptions, undefined, provider);
			assert.strictEqual(request.thinking, true, provider);
		}
	});

	test("V-INV-06 | the deepseek adapter still returns provider content", async () => {
		const captured: CapturedInvocation[] = [];
		const content = await invokeLlm(
			{
				provider: "deepseek",
				model: "deepseek-flash",
				token: "token",
				temperature: 0.2,
				systemPrompt: "sys",
				userPrompt: "user",
				thinking: false,
			},
			createFactories(captured),
		);

		assert.strictEqual(content, "OK");
		assert.strictEqual(captured.length, 1);
	});
});
