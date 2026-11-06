import { LLMRuntimeError } from "@fanilosendrison/llm-runtime";
import type { CommitJobResultError } from "../../types.ts";
import { sanitizeSensitiveDiagnostic } from "../core/sensitive-diagnostic-sanitizer.ts";

export const PROVIDER_FAILURE_KINDS = [
	"rate_limit",
	"overloaded",
	"transient_provider",
	"timeout",
	"provider_protocol",
	"response_parse",
] as const;
export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number];

/** Only typed runtime outages may authorize provider failover, never message text. */
export function createLlmJobFailure(
	id: string,
	error: unknown,
): CommitJobResultError {
	const diagnostic = sanitizeSensitiveDiagnostic(
		error instanceof Error ? error.message : String(error),
	);
	const kind =
		error instanceof LLMRuntimeError
			? PROVIDER_FAILURE_KINDS.find((candidate) => candidate === error.kind)
			: undefined;
	return {
		success: false,
		id,
		error: `LLM Fatal Error: ${diagnostic}`,
		...(kind ? { providerFailureKind: kind } : {}),
	};
}
