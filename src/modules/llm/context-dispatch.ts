import { InvalidRequestError } from "@fanilosendrison/llm-runtime";
import {
	ContextAdmissionError,
	contextRequestDigest,
} from "./context-admission.ts";
import {
	type ContextExecutionDecision,
	PORTABLE_WIRE_BYTES,
	PortableRequestError,
} from "./context-execution.ts";
import {
	type ContextOverflowEvidence,
	inspectContextOverflow,
} from "./context-overflow.ts";
import type {
	ContextAuthority,
	ContextDecision,
	ContextRequest,
} from "./context-types.ts";

/** Revalidate the same frozen request before every physical runtime send. */
export function createContextDispatch(
	context: ContextRequest,
	decision: ContextExecutionDecision | ContextDecision,
	authority: ContextAuthority,
	transport: typeof globalThis.fetch,
) {
	let refusal: ContextAdmissionError | PortableRequestError | undefined;
	let overflow: ContextOverflowEvidence | undefined;
	const portable = decision.status === "PORTABLE_ATTEMPT_ALLOWED";
	const assertCurrent = () => {
		if (contextRequestDigest(context) !== decision.requestDigest)
			throw new ContextAdmissionError("COUNTING_UNSUPPORTED");
		if (portable) return;
		const proof =
			decision.status === "CONTEXT_CAPACITY_PROVEN" ? decision.proof : decision;
		if (
			!("validFrom" in proof) ||
			!("validUntil" in proof) ||
			proof.status !== "ADMITTED"
		)
			throw new ContextAdmissionError("CAPABILITY_STALE");
		let now: number;
		try {
			now = authority.now();
		} catch {
			throw new ContextAdmissionError("CAPABILITY_STALE");
		}
		if (
			!Number.isSafeInteger(now) ||
			proof.validFrom === undefined ||
			proof.validUntil === undefined ||
			now < proof.validFrom ||
			now >= proof.validUntil
		)
			throw new ContextAdmissionError("CAPABILITY_STALE");
	};
	const fetch: typeof globalThis.fetch = async (input, init) => {
		try {
			assertCurrent();
			if (
				portable &&
				(typeof init?.body !== "string" ||
					Buffer.byteLength(init.body, "utf8") > PORTABLE_WIRE_BYTES)
			)
				throw new PortableRequestError("PORTABLE_WIRE_LIMIT");
		} catch (error) {
			refusal =
				error instanceof ContextAdmissionError ||
				error instanceof PortableRequestError
					? error
					: new ContextAdmissionError("COUNTING_UNSUPPORTED");
			throw new InvalidRequestError({
				message: refusal.message,
				cause: refusal,
			});
		}
		const response = await transport(input, init);
		overflow = await inspectContextOverflow(
			context,
			decision.requestDigest,
			response,
		);
		return response;
	};
	return {
		assertCurrent,
		fetch,
		refusal: () => refusal,
		overflow: () => overflow,
	};
}
