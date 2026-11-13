import { InvalidRequestError } from "@fanilosendrison/llm-runtime";
import { z } from "zod";

const OVERFLOW_CODES = {
	mistral: "invalid_request_prompt_too_long",
	openai: "context_length_exceeded",
} as const;
const OVERFLOW_REASONS = [
	"provider-refusal",
	"indivisible-path",
	"planning-budget-exhausted",
] as const;
export const contextOverflowReceiptSchema = z
	.object({
		status: z.literal("CONTEXT_OVERFLOW_REPORTED"),
		provider: z.custom<keyof typeof OVERFLOW_CODES>(
			(value) =>
				typeof value === "string" && Object.hasOwn(OVERFLOW_CODES, value),
		),
		model: z.string().min(1).max(65536),
		requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
		httpStatus: z.literal(400),
		providerCode: z.string(),
		reason: z.enum(OVERFLOW_REASONS),
	})
	.strict()
	.refine(
		(receipt) => receipt.providerCode === OVERFLOW_CODES[receipt.provider],
		"Provider overflow code mismatch",
	);
export type ContextOverflowReceipt = z.infer<
	typeof contextOverflowReceiptSchema
>;

import type { ContextRequest } from "./context-types.ts";

export interface ContextOverflowEvidence {
	readonly status: "CONTEXT_OVERFLOW_REPORTED";
	readonly provider: string;
	readonly model: string;
	readonly requestDigest: string;
	readonly httpStatus: 400;
	readonly providerCode: string;
}
export class ContextOverflowError extends InvalidRequestError {
	readonly evidence: ContextOverflowEvidence;
	readonly reason: (typeof OVERFLOW_REASONS)[number];
	constructor(
		evidence: ContextOverflowEvidence,
		attempts: number,
		reason: (typeof OVERFLOW_REASONS)[number] = "provider-refusal",
	) {
		super({
			message: `CONTEXT_OVERFLOW_REPORTED: ${reason.replaceAll("-", " ")}`,
			attempts,
		});
		this.evidence = Object.freeze(evidence);
		this.reason = reason;
	}
}
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** Closed provider/status/schema whitelist, never an exception-message classifier. */
export function classifyContextOverflow(
	context: ContextRequest,
	requestDigest: string,
	status: number,
	body: unknown,
): ContextOverflowEvidence | undefined {
	if (status !== 400 || !object(body)) return undefined;
	const nested = object(body.error) ? body.error.code : undefined;
	let code: string;
	if (
		context.provider === "mistral" &&
		(body.code === OVERFLOW_CODES.mistral || nested === OVERFLOW_CODES.mistral)
	) {
		if (body.code !== undefined && nested !== undefined && body.code !== nested)
			return undefined;
		code = OVERFLOW_CODES.mistral;
	} else if (
		context.provider === "openai" &&
		nested === OVERFLOW_CODES.openai
	) {
		code = OVERFLOW_CODES.openai;
	} else return undefined;
	return Object.freeze({
		status: "CONTEXT_OVERFLOW_REPORTED",
		provider: context.provider,
		model: context.model,
		requestDigest,
		httpStatus: 400,
		providerCode: code,
	});
}

/** Bounded inspection of a clone. Leave the original response/runtime classification intact. */
export async function inspectContextOverflow(
	context: ContextRequest,
	digest: string,
	response: Response,
): Promise<ContextOverflowEvidence | undefined> {
	if (
		response.status !== 400 ||
		!["mistral", "openai"].includes(context.provider)
	)
		return undefined;
	const reader = response.clone().body?.getReader();
	if (!reader) return undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const read = async (): Promise<unknown> => {
			const chunks: Uint8Array[] = [];
			let size = 0;
			for (;;) {
				const part = await reader.read();
				if (part.done) break;
				size += part.value.byteLength;
				if (size > 16_384) return undefined;
				chunks.push(part.value);
			}
			return JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
			);
		};
		const body = await Promise.race([
			read(),
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), 1000);
			}),
		]);
		return classifyContextOverflow(context, digest, response.status, body);
	} catch {
		return undefined;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		// Tee cancellation may await the original branch; never await it here.
		void reader.cancel().catch(() => {});
	}
}
