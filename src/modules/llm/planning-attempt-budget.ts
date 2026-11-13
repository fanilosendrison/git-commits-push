import { z } from "zod";
import type { ContextAuthority } from "./context-types.ts";

export const MAX_PLANNING_PARTITIONS = 32;
export const MAX_CONTEXT_PROOFS = 2048;
export const MAX_PLANNING_CALLS = 64;
export const MAX_PLANNING_TRANSPORT_RECOVERIES = 4;

export const planningBudgetSchema = z
	.object({
		calls: z.number().int().min(0).max(MAX_PLANNING_CALLS),
		recoveries: z.number().int().min(0).max(MAX_PLANNING_TRANSPORT_RECOVERIES),
		malformed: z.number().int().min(0).max(1),
		proofs: z.number().int().min(0).max(MAX_CONTEXT_PROOFS),
	})
	.strict();
export type PlanningBudgetState = z.infer<typeof planningBudgetSchema>;

/** A settled result may only advance consumption; absence never erases known debt. */
export function acceptPlanningBudget(
	previous: PlanningBudgetState | undefined,
	incoming: PlanningBudgetState | undefined,
): PlanningBudgetState | undefined {
	if (incoming === undefined) {
		if (previous !== undefined)
			throw new Error("Missing planning budget receipt");
		return undefined;
	}
	const next = planningBudgetSchema.parse(incoming);
	if (
		previous &&
		(Object.keys(previous) as (keyof PlanningBudgetState)[]).some(
			(key) => next[key] < previous[key],
		)
	)
		throw new Error("Planning budget receipt regressed");
	return next;
}

/** Shared across partitions; settled receipts carry consumption into later jobs. */
export class PlanningAttemptBudget {
	private calls = 0;
	private recoveries = 0;
	private malformed = 0;
	private proofs = 0;
	private authorities = new WeakMap<ContextAuthority, ContextAuthority>();

	constructor(previous?: PlanningBudgetState) {
		if (previous !== undefined) {
			const state = planningBudgetSchema.parse(previous);
			this.calls = state.calls;
			this.recoveries = state.recoveries;
			this.malformed = state.malformed;
			this.proofs = state.proofs;
		}
	}

	/** Count all preliminary, greedy and dispatch proof requests in one pool. */
	boundAuthority(authority: ContextAuthority): ContextAuthority {
		const existing = this.authorities.get(authority);
		if (existing) return existing;
		const wrapped: ContextAuthority = {
			scope: authority.scope,
			...(authority.countTimeoutMilliseconds === undefined
				? {}
				: { countTimeoutMilliseconds: authority.countTimeoutMilliseconds }),
			now: () => authority.now(),
			resolve: (request) => {
				const profile = authority.resolve(request);
				const counter = profile?.count;
				return (
					profile && {
						...profile,
						count: async (input, signal) => {
							if (this.proofs >= MAX_CONTEXT_PROOFS)
								throw new Error("Context proof budget exhausted");
							this.proofs++;
							if (!counter) throw new Error("Missing qualified counter");
							return counter(input, signal);
						},
					}
				);
			},
		};
		this.authorities.set(authority, wrapped);
		this.authorities.set(wrapped, wrapped);
		return wrapped;
	}

	beginCall(): number {
		if (this.calls >= MAX_PLANNING_CALLS)
			throw new Error("Planning call budget exhausted");
		this.calls++;
		return 1 + MAX_PLANNING_TRANSPORT_RECOVERIES - this.recoveries;
	}

	chargeTransport(attempts: number): void {
		if (
			!Number.isSafeInteger(attempts) ||
			attempts < 1 ||
			attempts - 1 > MAX_PLANNING_TRANSPORT_RECOVERIES - this.recoveries
		)
			throw new Error("Invalid shared transport attempt evidence");
		this.recoveries += attempts - 1;
	}

	repeatMalformed(): boolean {
		if (this.malformed >= 1) return false;
		this.malformed++;
		return true;
	}

	snapshot(): Readonly<{
		calls: number;
		recoveries: number;
		malformed: number;
		proofs: number;
	}> {
		return Object.freeze({
			calls: this.calls,
			recoveries: this.recoveries,
			malformed: this.malformed,
			proofs: this.proofs,
		});
	}
}
