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
		});
	}

	const response = await adapter.call({
		messages: adapterFactories.buildSimplePrompt({
			system: payload.systemPrompt,
			user: payload.userPrompt,
		}),
		temperature: payload.temperature,
		...(payload.thinking ? { thinking: true, reasoningEffort: "high" } : {}),
	});
	return response.content;
}
