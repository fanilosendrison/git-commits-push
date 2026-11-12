import type { ContextAuthority } from "./context-types.ts";

export const MAX_PLANNING_PARTITIONS = 32;
export const MAX_CONTEXT_PROOFS = 2048;
export const MAX_PLANNING_CALLS = 64;
export const MAX_PLANNING_TRANSPORT_RECOVERIES = 4;

/** Shared per logical repository job, never reconstructed for each partition. */
export class PlanningAttemptBudget {
	private calls = 0;
	private recoveries = 0;
	private malformed = 0;
	private proofs = 0;
	private authorities = new WeakMap<ContextAuthority, ContextAuthority>();

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
