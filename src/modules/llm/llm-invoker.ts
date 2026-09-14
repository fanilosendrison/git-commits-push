import {
	buildSimplePrompt,
	createAnthropicAdapter,
	createGoogleAdapter,
	createOpenAIAdapter,
	createOpenAICompatibleAdapter,
	type ProviderAdapter,
} from "@fanilosendrison/llm-runtime";

type OpenAICompatibleProvider =
	| "deepseek"
	| "mistral"
	| "groq"
	| "together"
	| "ollama";

const DEEPSEEK_PROVIDER = "deepseek";

/**
 * DeepSeek enables thinking mode at high effort when the request omits the
 * field, so an omitted `thinking: false` used to mean "provider default"
 * instead of "disabled" and could stall a call for minutes. The provider
 * option makes the disabled state explicit; `undefined` keeps the upstream
 * default. Other providers must not receive this DeepSeek-only option.
 */
function buildDeepSeekProviderOptions(payload: {
	readonly provider: string;
	readonly thinking?: boolean;
}): Record<string, unknown> | undefined {
	if (
		payload.provider !== DEEPSEEK_PROVIDER ||
		payload.thinking === undefined
	) {
		return undefined;
	}
	return payload.thinking
		? { thinking: { type: "enabled", reasoningEffort: "high" } }
		: { thinking: { type: "disabled" } };
}

export interface LlmAdapterFactories {
	readonly buildSimplePrompt: typeof buildSimplePrompt;
	readonly createAnthropicAdapter: typeof createAnthropicAdapter;
	readonly createGoogleAdapter: typeof createGoogleAdapter;
	readonly createOpenAIAdapter: typeof createOpenAIAdapter;
	readonly createOpenAICompatibleAdapter: typeof createOpenAICompatibleAdapter;
}

const defaultLlmAdapterFactories: LlmAdapterFactories = {
	buildSimplePrompt,
	createAnthropicAdapter,
	createGoogleAdapter,
	createOpenAIAdapter,
	createOpenAICompatibleAdapter,
};

/** Invoke one provider adapter through the shared runtime contract. */
export async function invokeLlm(
	payload: {
		provider: string;
		model: string;
		token: string;
		temperature: number;
		systemPrompt: string;
		userPrompt: string;
		stripJsonFence?: boolean;
		thinking?: boolean;
	},
	adapterFactories: LlmAdapterFactories = defaultLlmAdapterFactories,
): Promise<string> {
	const commonConfig = {
		model: payload.model,
		apiKey: payload.token,
		sanitization: {
			stripThinkingTags: true,
			stripJsonFence: payload.stripJsonFence ?? true,
		},
	};

	const deepSeekProviderOptions = buildDeepSeekProviderOptions(payload);
	const isDeepSeek = payload.provider === DEEPSEEK_PROVIDER;

	let adapter: ProviderAdapter;
	if (payload.provider === "anthropic") {
		adapter = adapterFactories.createAnthropicAdapter(commonConfig);
	} else if (payload.provider === "openai") {
		adapter = adapterFactories.createOpenAIAdapter(commonConfig);
	} else if (payload.provider === "google") {
		adapter = adapterFactories.createGoogleAdapter(commonConfig);
	} else {
		adapter = adapterFactories.createOpenAICompatibleAdapter({
			...commonConfig,
			provider: payload.provider as OpenAICompatibleProvider,
			...(deepSeekProviderOptions !== undefined
				? { providerOptions: deepSeekProviderOptions }
				: {}),
		});
	}

	const response = await adapter.call({
		messages: adapterFactories.buildSimplePrompt({
			system: payload.systemPrompt,
			user: payload.userPrompt,
		}),
		temperature: payload.temperature,
		// Legacy portable field: kept for non-DeepSeek providers only.
		...(!isDeepSeek && payload.thinking
			? { thinking: true, reasoningEffort: "high" }
			: {}),
	});
	return response.content;
}
