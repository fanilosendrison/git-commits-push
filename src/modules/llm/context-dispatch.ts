import { InvalidRequestError } from "@fanilosendrison/llm-runtime";
import {
	ContextAdmissionError,
	contextRequestDigest,
} from "./context-admission.ts";
import type {
	ContextAuthority,
	ContextDecision,
	ContextRequest,
} from "./context-types.ts";

/** Revalidate at every physical send, including retries owned by the runtime. */
export function createContextDispatch(
	context: ContextRequest,
	decision: ContextDecision,
	authority: ContextAuthority,
	transport: typeof globalThis.fetch,
) {
	let refusal: ContextAdmissionError | undefined;
	const assertCurrent = () => {
		if (contextRequestDigest(context) !== decision.requestDigest)
			throw new ContextAdmissionError("COUNTING_UNSUPPORTED");
		let now: number;
		try {
			now = authority.now();
		} catch {
			throw new ContextAdmissionError("CAPABILITY_STALE");
		}
		if (
			!Number.isSafeInteger(now) ||
			decision.validFrom === undefined ||
			decision.validUntil === undefined ||
			now < decision.validFrom ||
			now >= decision.validUntil
		)
			throw new ContextAdmissionError("CAPABILITY_STALE");
	};
	const fetch: typeof globalThis.fetch = async (input, init) => {
		try {
			assertCurrent();
		} catch (error) {
			refusal =
				error instanceof ContextAdmissionError
					? error
					: new ContextAdmissionError("COUNTING_UNSUPPORTED");
			// Non-retryable local carrier: no fabricated provider HTTP response.
			// The invoker restores the original admission failure at its boundary.
			throw new InvalidRequestError({
				message: refusal.message,
				cause: refusal,
			});
		}
		return transport(input, init);
	};
	return { assertCurrent, fetch, refusal: () => refusal };
}
