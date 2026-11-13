import {
	admitContext,
	ContextAdmissionError,
	contextRequestDigest,
	freezeContextRequest,
} from "./context-admission.ts";
import type {
	ContextAuthority,
	ContextDecision,
	ContextProfile,
	ContextRequest,
} from "./context-types.ts";

/** Operational allocations, never provider context capacities or token estimates. */
export const PORTABLE_REQUEST_BYTES = 65_536;
export const PORTABLE_WIRE_BYTES = 131_072;
export const PORTABLE_OUTPUT_TOKENS = 4096;
export const PORTABLE_POLICY = "gcp-portable-v1";
const PROVIDERS = new Set([
	"anthropic",
	"openai",
	"google",
	"deepseek",
	"mistral",
	"groq",
	"together",
	"ollama",
]);

export type ContextExecutionDecision =
	| {
			readonly status: "CONTEXT_CAPACITY_PROVEN";
			readonly requestDigest: string;
			readonly proof: ContextDecision;
	  }
	| {
			readonly status: "PORTABLE_ATTEMPT_ALLOWED";
			readonly requestDigest: string;
			readonly policy: typeof PORTABLE_POLICY;
			readonly requestBytes: number;
			readonly responseTokens: number;
	  };

export class PortableRequestError extends Error {
	readonly reason:
		| "PORTABLE_REQUEST_LIMIT"
		| "PORTABLE_OUTPUT_LIMIT"
		| "PORTABLE_WIRE_LIMIT";
	constructor(
		reason:
			| "PORTABLE_REQUEST_LIMIT"
			| "PORTABLE_OUTPUT_LIMIT"
			| "PORTABLE_WIRE_LIMIT",
	) {
		super(reason);
		this.reason = reason;
		this.name = "PortableRequestError";
	}
}

/** No profile permits bounded execution; a failed selected proof never silently downgrades. */
export async function authorizeContextExecution(
	input: ContextRequest,
	authority: ContextAuthority,
): Promise<ContextExecutionDecision> {
	const request = freezeContextRequest(input);
	let profile: ContextProfile | undefined;
	try {
		profile = authority.resolve(request);
	} catch {
		throw new ContextAdmissionError("CAPABILITY_UNKNOWN");
	}
	if (profile) {
		const proof = await admitContext(request, {
			...authority,
			resolve: () => profile,
		});
		if (proof.status !== "ADMITTED")
			throw new ContextAdmissionError(proof.status);
		return Object.freeze({
			status: "CONTEXT_CAPACITY_PROVEN",
			requestDigest: proof.requestDigest,
			proof,
		});
	}
	if (!PROVIDERS.has(request.provider) || !request.model.trim())
		throw new ContextAdmissionError("CAPABILITY_UNKNOWN");
	const responseTokens = request.request.maxTokens;
	if (
		!Number.isSafeInteger(responseTokens) ||
		responseTokens === undefined ||
		responseTokens < 1 ||
		responseTokens > PORTABLE_OUTPUT_TOKENS
	)
		throw new PortableRequestError("PORTABLE_OUTPUT_LIMIT");
	const requestBytes = Buffer.byteLength(JSON.stringify(request), "utf8");
	if (requestBytes > PORTABLE_REQUEST_BYTES)
		throw new PortableRequestError("PORTABLE_REQUEST_LIMIT");
	return Object.freeze({
		status: "PORTABLE_ATTEMPT_ALLOWED",
		requestDigest: contextRequestDigest(request),
		policy: PORTABLE_POLICY,
		requestBytes,
		responseTokens,
	});
}

/** Only input-size refusals are repairable by whole-path subdivision. */
export function isSplittableRequestRefusal(error: unknown): boolean {
	return (
		(error instanceof PortableRequestError &&
			error.reason === "PORTABLE_REQUEST_LIMIT") ||
		(error instanceof ContextAdmissionError &&
			error.status === "REJECTED_INPUT_CAPACITY")
	);
}
