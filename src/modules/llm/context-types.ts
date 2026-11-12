import type { LLMRequest } from "@fanilosendrison/llm-runtime";

/** Exact logical adapter input, excluding authentication. Protocol owns wire overhead. */
export interface ContextRequest {
	readonly provider: string;
	readonly model: string;
	readonly protocol: string;
	readonly providerOptions: Readonly<Record<string, unknown>> | undefined;
	readonly request: LLMRequest;
}

export type ContextStatus =
	| "ADMITTED"
	| "REJECTED_INPUT_CAPACITY"
	| "REJECTED_OUTPUT_RESERVE"
	| "CAPABILITY_UNKNOWN"
	| "CAPABILITY_STALE"
	| "COUNTING_UNSUPPORTED";

/** A counter must bind the entire request and attest protocol/template inclusion. */
export interface ContextCount {
	readonly requestDigest: string;
	readonly revision: string;
	readonly encoding: string;
	readonly includesProtocol: boolean;
	readonly inputTokens: number;
}

/** Executable qualification belongs to trusted code, never a job/settings JSON object. */
export interface ContextProfile {
	readonly scope: "production" | "test";
	readonly id: string;
	readonly provider: string;
	readonly model: string;
	readonly revision: string;
	readonly protocol: string;
	readonly encoding: string;
	readonly provenance: string;
	readonly qualifiedAt: number;
	readonly expiresAt: number;
	readonly inputLimit: number;
	readonly outputLimit: number;
	readonly combinedLimit?: number;
	readonly minimumResponseTokens: number;
	readonly count: (
		request: ContextRequest,
		signal: AbortSignal,
	) => Promise<ContextCount>;
}

export interface ContextAuthority {
	readonly scope: "production" | "test";
	/** Test-only shorter deadline injection; production always uses the fixed bound. */
	readonly countTimeoutMilliseconds?: number;
	readonly now: () => number;
	readonly resolve: (request: ContextRequest) => ContextProfile | undefined;
}

export interface ContextDecision {
	readonly status: ContextStatus;
	readonly requestDigest: string;
	readonly profileId?: string;
	readonly inputTokens?: number;
	readonly responseTokens?: number;
	readonly validUntil?: number;
	readonly validFrom?: number;
}
