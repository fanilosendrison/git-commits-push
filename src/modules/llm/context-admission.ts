import { createHash } from "node:crypto";
import type {
	ContextAuthority,
	ContextDecision,
	ContextProfile,
	ContextRequest,
	ContextStatus,
} from "./context-types.ts";

const MAX_COUNTING_MILLISECONDS = 10_000;

/** Hash exact application serialization; no approximate tokenizer or JCS claim. */
export function contextRequestDigest(request: ContextRequest): string {
	return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function freezeValue(value: unknown, seen = new WeakSet<object>()): void {
	if (value && typeof value === "object" && !seen.has(value)) {
		seen.add(value);
		for (const child of Object.values(value)) freezeValue(child, seen);
		Object.freeze(value);
	}
}

/** Count and dispatch use private immutable snapshots, not caller-owned objects. */
export function freezeContextRequest(request: ContextRequest): ContextRequest {
	const copy = structuredClone(request);
	freezeValue(copy);
	return copy;
}

function positive(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

export class ContextAdmissionError extends Error {
	readonly status: Exclude<ContextStatus, "ADMITTED">;
	constructor(status: Exclude<ContextStatus, "ADMITTED">) {
		super(`Context admission refused: ${status}`);
		this.name = "ContextAdmissionError";
		this.status = status;
	}
}

/** Missing production qualification is refusal, never implicit test qualification. */
export const productionContextAuthority: ContextAuthority = Object.freeze({
	scope: "production",
	now: Date.now,
	resolve: () => undefined,
});

/** Verify model, provenance, lifetime, complete counting evidence and all limits. */
export async function admitContext(
	input: ContextRequest,
	authority: ContextAuthority,
): Promise<ContextDecision> {
	let request: ContextRequest;
	let requestDigest: string;
	try {
		request = freezeContextRequest(input);
		requestDigest = contextRequestDigest(request);
	} catch {
		return { status: "COUNTING_UNSUPPORTED", requestDigest: "" };
	}
	const reject = (status: ContextStatus): ContextDecision => ({
		status,
		requestDigest,
	});
	let profile: ContextProfile | undefined;
	try {
		profile = authority.resolve(request);
	} catch {
		return reject("CAPABILITY_UNKNOWN");
	}
	if (!profile) return reject("CAPABILITY_UNKNOWN");
	const { count, ...mutable } = profile;
	const p = Object.freeze({ ...mutable });
	if (
		(authority.scope !== "test" && authority.scope !== "production") ||
		(p.scope !== "test" && p.scope !== "production") ||
		(authority.scope === "production" && p.scope !== "production") ||
		p.provider !== request.provider ||
		p.model !== request.model ||
		!p.id ||
		!p.revision ||
		!p.provenance ||
		!positive(p.inputLimit) ||
		!positive(p.outputLimit) ||
		!positive(p.minimumResponseTokens) ||
		(p.combinedLimit !== undefined && !positive(p.combinedLimit))
	)
		return reject("CAPABILITY_UNKNOWN");
	const stale = () => {
		let now: number;
		try {
			now = authority.now();
		} catch {
			return true;
		}
		return (
			!Number.isSafeInteger(now) ||
			!Number.isSafeInteger(p.qualifiedAt) ||
			!Number.isSafeInteger(p.expiresAt) ||
			p.qualifiedAt > now ||
			p.expiresAt <= now
		);
	};
	if (stale()) return reject("CAPABILITY_STALE");
	if (
		p.protocol !== request.protocol ||
		!p.encoding ||
		typeof count !== "function"
	)
		return reject("COUNTING_UNSUPPORTED");
	const reserve = request.request.maxTokens;
	if (
		reserve === undefined ||
		!positive(reserve) ||
		reserve < p.minimumResponseTokens ||
		reserve > p.outputLimit
	)
		return reject("REJECTED_OUTPUT_RESERVE");
	const controller = new AbortController();
	const requestedDeadline =
		authority.scope === "test"
			? (authority.countTimeoutMilliseconds ?? MAX_COUNTING_MILLISECONDS)
			: MAX_COUNTING_MILLISECONDS;
	if (
		!positive(requestedDeadline) ||
		requestedDeadline > MAX_COUNTING_MILLISECONDS
	)
		return reject("COUNTING_UNSUPPORTED");
	const deadlineAt = performance.now() + requestedDeadline;
	const expired = () => performance.now() >= deadlineAt;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const deadline = new Promise<never>((_resolve, rejectDeadline) => {
			timer = setTimeout(() => {
				controller.abort();
				rejectDeadline(new Error("Counting deadline expired"));
			}, requestedDeadline);
		});
		const evidence = await Promise.race([
			count(request, controller.signal),
			deadline,
		]);
		if (expired()) {
			controller.abort();
			return reject("COUNTING_UNSUPPORTED");
		}
		if (stale()) return reject("CAPABILITY_STALE");
		if (
			evidence.requestDigest !== requestDigest ||
			evidence.revision !== p.revision ||
			evidence.encoding !== p.encoding ||
			evidence.includesProtocol !== true ||
			!Number.isSafeInteger(evidence.inputTokens) ||
			evidence.inputTokens < 0
		)
			return reject("COUNTING_UNSUPPORTED");
		if (
			evidence.inputTokens > p.inputLimit ||
			(p.combinedLimit !== undefined &&
				(reserve > p.combinedLimit ||
					evidence.inputTokens > p.combinedLimit - reserve))
		)
			return reject("REJECTED_INPUT_CAPACITY");
		if (expired()) {
			controller.abort();
			return reject("COUNTING_UNSUPPORTED");
		}
		return Object.freeze({
			status: "ADMITTED",
			requestDigest,
			profileId: p.id,
			inputTokens: evidence.inputTokens,
			responseTokens: reserve,
			validUntil: p.expiresAt,
			validFrom: p.qualifiedAt,
		});
	} catch {
		// A synchronous late rejection can settle before the overdue timer runs.
		// Failed counting owns no valid evidence; cancel cooperative work too.
		controller.abort();
		return reject("COUNTING_UNSUPPORTED");
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export async function requireContextAdmission(
	request: ContextRequest,
	authority: ContextAuthority,
): Promise<ContextDecision> {
	const decision = await admitContext(request, authority);
	if (decision.status !== "ADMITTED")
		throw new ContextAdmissionError(decision.status);
	return decision;
}
