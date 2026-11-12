import {
	buildSimplePrompt,
	createAnthropicAdapter,
	createGoogleAdapter,
	createOpenAIAdapter,
	createOpenAICompatibleAdapter,
} from "@fanilosendrison/llm-runtime";
import { main } from "../../src/entrypoints/turnlock-to-llm-bridge.ts";
import { resolveAuthToken } from "../../src/modules/core/auth-resolver.ts";
import {
	invokeLlm,
	type LlmAdapterFactories,
} from "../../src/modules/llm/llm-invoker.ts";
import { syntheticContextAuthority } from "../helpers/context-authority.ts";

// Test bootstrap only: no production registry, settings or environment promotion.
const contextAuthority = syntheticContextAuthority();
const factories: LlmAdapterFactories = {
	buildSimplePrompt,
	createAnthropicAdapter,
	createGoogleAdapter,
	createOpenAIAdapter,
	createOpenAICompatibleAdapter,
	contextAuthority,
};
await main({
	contextAuthority,
	resolveAuthToken,
	invokeLlm: (payload, _unused, budget) =>
		invokeLlm(payload, factories, budget),
});
