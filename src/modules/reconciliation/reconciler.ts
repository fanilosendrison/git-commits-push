/** Durable SQLite reconciliation ownership and generation transitions. */
import type { DatabaseSync } from "node:sqlite";
import {
	isProcessAlive,
	readProcessStartIdentity,
} from "./process-identity.ts";
import { ReconcilerFencedError } from "./reconciler-errors.ts";
import {
	type ReconcilerStateRecord,
	readReconcilerState,
} from "./reconciler-state.ts";
import { runReconcilerTransaction } from "./reconciler-transaction.ts";

export {
	authorizeActiveExecutionStart,
	clearActiveExecution,
	type FenceActiveExecutionOptions,
	type RegisterActiveExecutionOptions,
	registerActiveExecution,
} from "./active-execution-state.ts";
export {
	currentBootEpochMs,
	establishCurrentProcessIdentity,
	isProcessAlive,
	readProcessStartIdentity,
} from "./process-identity.ts";
export { ReconcilerFencedError } from "./reconciler-errors.ts";

export interface RegisterReconciliationOptions {
	readonly token: string;
	readonly pid: number;
	readonly bootEpochMs: number;
	readonly processIdentity: string;
	readonly callerName: string;
	readonly originAgent: string;
	readonly originSessionId?: string;
	readonly nowEpochMs: number;
}

export type RegisterReconciliationResult =
	| {
			readonly kind: "OWNER";
			readonly generation: number;
			readonly completedGeneration: number;
			readonly recovered: boolean;
			readonly previousOwnerPid: number | null;
			readonly requiresExecutionRecovery: boolean;
	  }
	| {
			readonly kind: "COALESCED";
			readonly generation: number;
			readonly ownerPid: number | null;
			readonly ownerCallerName: string | null;
	  };

export interface FinishReconciliationPassOptions {
	readonly token: string;
	readonly pid: number;
	readonly generation: number;
	readonly success: boolean;
	readonly nowEpochMs: number;
}

export type FinishReconciliationResult =
	| {
			readonly decision: "CONTINUE";
			readonly generation: number;
			readonly completedGeneration: number;
			readonly success: boolean;
	  }
	| {
			readonly decision: "STOP_SUCCESS";
			readonly completedGeneration: number;
	  }
	| {
			readonly decision: "STOP_FAILED";
			readonly completedGeneration: number;
	  };

export interface HeartbeatOptions {
	readonly token: string;
	readonly pid: number;
	readonly nowEpochMs: number;
}

export interface ReleaseOwnershipOptions {
	readonly token: string;
	readonly pid: number;
}

function ownerIsAlive(state: ReconcilerStateRecord): boolean {
	if (
		state.ownerToken === null ||
		state.ownerPid === null ||
		state.ownerProcessIdentity === null ||
		state.runningGeneration === null
	) {
		return false;
	}
	if (!isProcessAlive(state.ownerPid)) return false;
	const currentIdentity = readProcessStartIdentity(state.ownerPid);
	return (
		currentIdentity === null || currentIdentity === state.ownerProcessIdentity
	);
}

function assertRegistrationOptions(
	options: RegisterReconciliationOptions,
): void {
	if (!options.token.trim())
		throw new TypeError("owner token must not be empty");
	if (!Number.isSafeInteger(options.pid) || options.pid <= 0) {
		throw new TypeError("owner pid must be a positive integer");
	}
	if (!Number.isSafeInteger(options.bootEpochMs) || options.bootEpochMs < 0) {
		throw new TypeError("owner boot epoch must be a non-negative integer");
	}
	if (!options.processIdentity.trim()) {
		throw new TypeError("owner process identity must not be empty");
	}
	if (!options.callerName.trim() || !options.originAgent.trim()) {
		throw new TypeError("owner caller and origin must not be empty");
	}
	if (
		options.originSessionId !== undefined &&
		!options.originSessionId.trim()
	) {
		throw new TypeError("owner session id must not be empty when provided");
	}
	if (!Number.isSafeInteger(options.nowEpochMs) || options.nowEpochMs < 0) {
		throw new TypeError("registration time must be a non-negative integer");
	}
}

class ReconciliationOwnerChanged extends Error {}

function executionMatchesObservation(
	current: ReconcilerStateRecord["activeExecution"],
	observed: ReconcilerStateRecord["activeExecution"],
): boolean {
	if (current === null || observed === null) return current === observed;
	return (
		current.token === observed.token &&
		current.generation === observed.generation &&
		current.pid === observed.pid &&
		current.processIdentity === observed.processIdentity &&
		current.groupId === observed.groupId &&
		current.boundaryKind === observed.boundaryKind &&
		current.ownerToken === observed.ownerToken &&
		current.state === observed.state
	);
}

function ownerMatchesObservation(
	current: ReconcilerStateRecord,
	observed: ReconcilerStateRecord,
): boolean {
	return (
		current.ownerToken === observed.ownerToken &&
		current.ownerPid === observed.ownerPid &&
		current.ownerProcessIdentity === observed.ownerProcessIdentity &&
		current.runningGeneration === observed.runningGeneration &&
		executionMatchesObservation(
			current.activeExecution,
			observed.activeExecution,
		)
	);
}

/** Atomically register one public reconciliation request before side effects. */
export function registerReconciliationRequest(
	db: DatabaseSync,
	options: RegisterReconciliationOptions,
): RegisterReconciliationResult {
	assertRegistrationOptions(options);
	for (let attempt = 0; attempt < 8; attempt++) {
		const observedState = readReconcilerState(db);
		const observedOwnerIsAlive = ownerIsAlive(observedState);
		try {
			return runReconcilerTransaction(db, () => {
				const state = readReconcilerState(db);
				if (!ownerMatchesObservation(state, observedState)) {
					throw new ReconciliationOwnerChanged();
				}
				const nextRequested = state.requestedGeneration + 1;
				if (observedOwnerIsAlive) {
					db.prepare(
						"UPDATE reconciler_state SET requested_generation = ? WHERE singleton_id = 1",
					).run(nextRequested);
					return {
						kind: "COALESCED",
						generation: nextRequested,
						ownerPid: state.ownerPid,
						ownerCallerName: state.ownerCallerName,
					};
				}

				const recovered = state.ownerToken !== null;
				const previousOwnerPid = state.ownerPid;
				db.prepare(
					`UPDATE reconciler_state SET
						requested_generation = ?, running_generation = ?, owner_token = ?,
						owner_pid = ?, owner_boot_epoch_ms = ?, owner_process_identity = ?,
						owner_caller_name = ?, owner_origin_agent = ?, owner_session_id = ?,
						heartbeat_at_epoch_ms = ?
					 WHERE singleton_id = 1`,
				).run(
					nextRequested,
					nextRequested,
					options.token,
					options.pid,
					options.bootEpochMs,
					options.processIdentity,
					options.callerName,
					options.originAgent,
					options.originSessionId ?? null,
					options.nowEpochMs,
				);
				return {
					kind: "OWNER",
					generation: nextRequested,
					completedGeneration: state.completedGeneration,
					recovered,
					previousOwnerPid,
					requiresExecutionRecovery: state.activeExecution !== null,
				};
			});
		} catch (error) {
			if (error instanceof ReconciliationOwnerChanged) continue;
			throw error;
		}
	}
	throw new ReconcilerFencedError(
		"Reconciler ownership changed repeatedly during admission; retry the invocation.",
	);
}

/** Finalize one pass only after its durable execution has been cleared. */
export function finishReconciliationPass(
	db: DatabaseSync,
	options: FinishReconciliationPassOptions,
): FinishReconciliationResult {
	return runReconcilerTransaction(db, () => {
		const state = readReconcilerState(db);
		if (state.ownerToken !== options.token || state.ownerPid !== options.pid) {
			throw new ReconcilerFencedError(
				"The reconciler owner token no longer matches; refusing to finalize another owner's pass.",
			);
		}
		if (state.activeExecution !== null) {
			throw new ReconcilerFencedError(
				"An active execution remains registered; refusing false pass completion.",
			);
		}
		if (state.runningGeneration !== options.generation) {
			throw new ReconcilerFencedError(
				`running_generation ${String(state.runningGeneration)} does not match pass generation ${options.generation}; refusing to finalize.`,
			);
		}

		const completedGeneration = options.success
			? options.generation
			: state.completedGeneration;
		if (state.requestedGeneration > options.generation) {
			const nextRunning = state.requestedGeneration;
			db.prepare(
				`UPDATE reconciler_state SET completed_generation = ?,
					running_generation = ?, heartbeat_at_epoch_ms = ?
				 WHERE singleton_id = 1`,
			).run(completedGeneration, nextRunning, options.nowEpochMs);
			return {
				decision: "CONTINUE",
				generation: nextRunning,
				completedGeneration,
				success: options.success,
			};
		}

		db.prepare(
			`UPDATE reconciler_state SET completed_generation = ?, running_generation = NULL,
				owner_token = NULL, owner_pid = NULL, owner_boot_epoch_ms = NULL,
				owner_process_identity = NULL, owner_caller_name = NULL,
				owner_origin_agent = NULL, owner_session_id = NULL,
				heartbeat_at_epoch_ms = NULL
			 WHERE singleton_id = 1`,
		).run(completedGeneration);
		return options.success
			? { decision: "STOP_SUCCESS", completedGeneration }
			: { decision: "STOP_FAILED", completedGeneration };
	});
}

/** Token-fenced owner heartbeat against a fully validated state row. */
export function heartbeatReconciler(
	db: DatabaseSync,
	options: HeartbeatOptions,
): boolean {
	const state = readReconcilerState(db);
	if (state.ownerToken !== options.token || state.ownerPid !== options.pid) {
		return false;
	}
	const result = db
		.prepare(
			`UPDATE reconciler_state SET heartbeat_at_epoch_ms = ?
			 WHERE singleton_id = 1 AND owner_token = ? AND owner_pid = ?`,
		)
		.run(options.nowEpochMs, options.token, options.pid);
	return result.changes === 1;
}

/** Release interrupted ownership only from a valid execution-free state. */
export function releaseReconciliationOwnership(
	db: DatabaseSync,
	options: ReleaseOwnershipOptions,
): boolean {
	return runReconcilerTransaction(db, () => {
		const state = readReconcilerState(db);
		if (state.ownerToken !== options.token || state.ownerPid !== options.pid) {
			return false;
		}
		if (state.activeExecution !== null) return false;
		const result = db
			.prepare(
				`UPDATE reconciler_state SET running_generation = NULL, owner_token = NULL,
					owner_pid = NULL, owner_boot_epoch_ms = NULL,
					owner_process_identity = NULL, owner_caller_name = NULL,
					owner_origin_agent = NULL, owner_session_id = NULL,
					heartbeat_at_epoch_ms = NULL
				 WHERE singleton_id = 1 AND owner_token = ? AND owner_pid = ?`,
			)
			.run(options.token, options.pid);
		return result.changes === 1;
	});
}
