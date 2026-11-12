import {
	ALL_LLM_ERROR_KINDS,
	type LLMErrorKind,
	LLMRuntimeError,
} from "@fanilosendrison/llm-runtime";
import type { CommitJobResultError } from "../../types.ts";
import { classifyError } from "../core/error-classifier.ts";
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
export type TerminalProviderFailureKind = Exclude<
	LLMErrorKind,
	ProviderFailureKind
>;

/** Closed public runtime taxonomy; terminal diagnostics never grant recovery. */
export function isTerminalProviderFailureKind(
	kind: unknown,
): kind is TerminalProviderFailureKind {
	return (
		ALL_LLM_ERROR_KINDS.some((candidate) => candidate === kind) &&
		!PROVIDER_FAILURE_KINDS.some((candidate) => candidate === kind)
	);
}

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
	const terminal =
		error instanceof LLMRuntimeError &&
		isTerminalProviderFailureKind(error.kind)
			? error.kind
			: undefined;
	const planning = classifyError(error, false);
	return {
		...(planning.kind === "retry" && planning.error.kind === "structural"
			? { planningFailureKind: "structural" as const }
			: {}),
		success: false,
		id,
		error: `LLM Fatal Error: ${diagnostic}`,
		...(kind ? { providerFailureKind: kind } : {}),
		...(terminal ? { terminalFailureKind: terminal } : {}),
	};
}
