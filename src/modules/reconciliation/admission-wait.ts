/**
 * Bounded process-local admission waiting. An incompatible live owner returns
 * WAIT, which performs no durable mutation; the caller polls and retries with
 * unchanged mode and arguments. No waiter, queue, or request state is durable.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
	currentBootEpochMs,
	registerReconciliationRequest,
} from "./reconciler.ts";
import type { ReconciliationInvocationMode } from "./reconciler-state.ts";

export const WAIT_POLL_INTERVALS_MS = [25, 50, 100, 200] as const;
export const WAIT_POLL_MAX_INTERVAL_MS = 250;

export type NonWaitRegistration = Exclude<
	ReturnType<typeof registerReconciliationRequest>,
	{ kind: "WAIT" }
>;

export type AdmissionAttemptOutcome =
	| {
			readonly kind: "admitted";
			readonly registration: NonWaitRegistration;
			readonly token: string;
	  }
	| { readonly kind: "interrupted" }
	| { readonly kind: "failed"; readonly error: unknown };

export interface AdmitReconciliationRequestOptions {
	readonly db: DatabaseSync;
	readonly mode: ReconciliationInvocationMode;
	readonly callerName: string;
	readonly originAgent: string;
	readonly originSessionId?: string;
	readonly processIdentity: string;
	readonly isInterrupted: () => boolean;
	/** Invoked after every registration attempt, including failures. */
	readonly onAttempt?: () => void;
	readonly delay?: (milliseconds: number) => Promise<void>;
}

export function waitPollInterval(attempt: number): number {
	if (attempt < WAIT_POLL_INTERVALS_MS.length) {
		return WAIT_POLL_INTERVALS_MS[attempt] as number;
	}
	return WAIT_POLL_MAX_INTERVAL_MS;
}

function defaultDelay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Register one request, polling while an incompatible owner runs. */
export async function admitReconciliationRequest(
	options: AdmitReconciliationRequestOptions,
): Promise<AdmissionAttemptOutcome> {
	const delay = options.delay ?? defaultDelay;
	let waitPollAttempt = 0;
	for (;;) {
		const token = randomBytes(16).toString("hex");
		let registration: ReturnType<typeof registerReconciliationRequest>;
		try {
			registration = registerReconciliationRequest(options.db, {
				bootEpochMs: currentBootEpochMs(),
				callerName: options.callerName,
				mode: options.mode,
				nowEpochMs: Date.now(),
				originAgent: options.originAgent,
				...(options.originSessionId === undefined
					? {}
					: { originSessionId: options.originSessionId }),
				pid: process.pid,
				processIdentity: options.processIdentity,
				token,
			});
		} catch (error) {
			options.onAttempt?.();
			return { error, kind: "failed" };
		}
		options.onAttempt?.();
		if (registration.kind !== "WAIT") {
			return { kind: "admitted", registration, token };
		}
		if (options.isInterrupted()) return { kind: "interrupted" };
		await delay(waitPollInterval(waitPollAttempt));
		waitPollAttempt += 1;
		if (options.isInterrupted()) return { kind: "interrupted" };
	}
}
