import {
	buildSimplePrompt,
	createAnthropicAdapter,
	createGoogleAdapter,
	createOpenAIAdapter,
	createOpenAICompatibleAdapter,
	LLMRuntimeError,
	type ProviderAdapter,
} from "@fanilosendrison/llm-runtime";
import {
	productionContextAuthority,
	requireContextAdmission,
} from "./context-admission.ts";
import { createContextDispatch } from "./context-dispatch.ts";
import { buildContextRequest, type LlmInvocation } from "./context-request.ts";
import type { ContextAuthority } from "./context-types.ts";
import { PLAN_RESPONSE_SANITIZATION } from "./plan-response-policy.ts";
import type { PlanningAttemptBudget } from "./planning-attempt-budget.ts";

type OpenAICompatibleProvider =
	| "deepseek"
	| "mistral"
	| "groq"
	| "together"
	| "ollama";

export interface LlmAdapterFactories {
	readonly buildSimplePrompt: typeof buildSimplePrompt;
	readonly createAnthropicAdapter: typeof createAnthropicAdapter;
	readonly createGoogleAdapter: typeof createGoogleAdapter;
	readonly createOpenAIAdapter: typeof createOpenAIAdapter;
	readonly createOpenAICompatibleAdapter: typeof createOpenAICompatibleAdapter;
	/** Explicit trusted test injection, never loaded from settings or job JSON. */
	readonly contextAuthority?: ContextAuthority;
	/** Trusted deterministic transport injection, not a settings/job option. */
	readonly fetch?: typeof globalThis.fetch;
}

const defaultLlmAdapterFactories: LlmAdapterFactories = {
	buildSimplePrompt,
	createAnthropicAdapter,
	createGoogleAdapter,
	createOpenAIAdapter,
	createOpenAICompatibleAdapter,
};

/** Admit a complete immutable request and send that exact snapshot through the runtime. */
export async function invokeLlm(
	payload: LlmInvocation,
	adapterFactories: LlmAdapterFactories = defaultLlmAdapterFactories,
	budget?: PlanningAttemptBudget,
): Promise<string> {
	const context = buildContextRequest(
		payload,
		adapterFactories.buildSimplePrompt,
	);
	const suppliedAuthority =
		adapterFactories.contextAuthority ?? productionContextAuthority;
	const authority =
		budget?.boundAuthority(suppliedAuthority) ?? suppliedAuthority;
	const decision = await requireContextAdmission(context, authority);
	const attempts = budget?.beginCall();
	const dispatch = createContextDispatch(
		context,
		decision,
		authority,
		adapterFactories.fetch ?? globalThis.fetch,
	);
	const commonConfig = {
		model: context.model,
		apiKey: payload.token,
		// Runtime defaults can quote provider bodies in diagnostics. The caller
		// reports only typed failure metadata, never unfiltered runtime text.
		logging: { enabled: false },
		sanitization: {
			...PLAN_RESPONSE_SANITIZATION,
			stripJsonFence: payload.stripJsonFence ?? true,
		},
		providerOptions: { ...context.providerOptions, fetch: dispatch.fetch },
		// Pinned runtime 0.1.3 policy, but extra attempts are shared by the whole job.
		...(attempts === undefined
			? {}
			: {
					retry: {
						maxAttempts: attempts,
						backoffBaseMs: 2000,
						maxBackoffMs: 60_000,
					},
				}),
	};
	let adapter: ProviderAdapter;
	if (context.provider === "anthropic")
		adapter = adapterFactories.createAnthropicAdapter(commonConfig);
	else if (context.provider === "openai")
		adapter = adapterFactories.createOpenAIAdapter(commonConfig);
	else if (context.provider === "google")
		adapter = adapterFactories.createGoogleAdapter(commonConfig);
	else
		adapter = adapterFactories.createOpenAICompatibleAdapter({
			...commonConfig,
			provider: context.provider as OpenAICompatibleProvider,
		});
	dispatch.assertCurrent();
	try {
		const response = await adapter.call(context.request);
		budget?.chargeTransport(response.attemptCount);
		if (dispatch.refusal()) throw dispatch.refusal();
		return response.content;
	} catch (error) {
		if (budget && error instanceof LLMRuntimeError)
			budget.chargeTransport(error.attempts ?? 0);
		throw dispatch.refusal() ?? error;
	}
}
