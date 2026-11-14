import { buildSimplePrompt } from "@fanilosendrison/llm-runtime";
import { freezeContextRequest } from "./context-admission.ts";
import type { ContextRequest } from "./context-types.ts";

export const LLM_PROTOCOL_ID = "llm-runtime-0.1.5/gcp-text-v1";
export const PLANNING_RESPONSE_RESERVE = 4096;

export interface LlmInvocation {
	readonly provider: string;
	readonly model: string;
	readonly token: string;
	readonly temperature: number;
	readonly systemPrompt: string;
	readonly userPrompt: string;
	readonly stripJsonFence?: boolean;
	readonly thinking?: boolean;
	readonly responseReserve?: number;
}

/** One authority for message construction, provider steering and explicit reserve. */
export function buildContextRequest(
	payload: LlmInvocation,
	promptBuilder: typeof buildSimplePrompt = buildSimplePrompt,
): ContextRequest {
	const deepseek = payload.provider === "deepseek";
	const providerOptions =
		deepseek && payload.thinking !== undefined
			? payload.thinking
				? { thinking: { type: "enabled", reasoningEffort: "high" } }
				: { thinking: { type: "disabled" } }
			: undefined;
	return freezeContextRequest({
		provider: payload.provider,
		model: payload.model,
		protocol: LLM_PROTOCOL_ID,
		providerOptions,
		request: {
			messages: promptBuilder({
				system: payload.systemPrompt,
				user: payload.userPrompt,
			}),
			temperature: payload.temperature,
			maxTokens: payload.responseReserve ?? PLANNING_RESPONSE_RESERVE,
			...(!deepseek && payload.thinking
				? { thinking: true, reasoningEffort: "high" }
				: {}),
		},
	});
}
