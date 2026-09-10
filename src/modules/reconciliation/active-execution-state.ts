import type { DatabaseSync } from "node:sqlite";
import { ReconcilerFencedError } from "./reconciler-errors.ts";
import {
	type ActiveExecutionRecord,
	POSIX_EXECUTION_BOUNDARY_KIND,
	readReconcilerState,
} from "./reconciler-state.ts";
import { runReconcilerTransaction } from "./reconciler-transaction.ts";

export interface RegisterActiveExecutionOptions {
	readonly ownerToken: string;
	readonly ownerPid: number;
	readonly generation: number;
	readonly executionToken: string;
	readonly executionPid: number;
	readonly executionProcessIdentity: string;
	readonly executionGroupId: number;
	readonly executionBoundaryKind: typeof POSIX_EXECUTION_BOUNDARY_KIND;
}

export interface FenceActiveExecutionOptions {
	readonly ownerToken: string;
	readonly ownerPid: number;
	readonly executionToken: string;
}

function requireNonEmpty(name: string, value: string): void {
	if (!value.trim()) throw new TypeError(`${name} must not be empty`);
}

function requirePositiveInteger(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${name} must be a positive integer`);
	}
}

function assertOwner(
	ownerToken: string | null,
	ownerPid: number | null,
	options: { readonly ownerToken: string; readonly ownerPid: number },
): void {
	if (ownerToken !== options.ownerToken || ownerPid !== options.ownerPid) {
		throw new ReconcilerFencedError(
			"The reconciler owner no longer matches; refusing to mutate active execution state.",
		);
	}
}

/** Register one paused execution before it can become Git-capable. */
export function registerActiveExecution(
	db: DatabaseSync,
	options: RegisterActiveExecutionOptions,
): ActiveExecutionRecord {
	requireNonEmpty("owner token", options.ownerToken);
	requireNonEmpty("execution token", options.executionToken);
	requireNonEmpty(
		"execution process identity",
		options.executionProcessIdentity,
	);
	requirePositiveInteger("owner pid", options.ownerPid);
	requirePositiveInteger("execution generation", options.generation);
	requirePositiveInteger("execution pid", options.executionPid);
	requirePositiveInteger("execution group id", options.executionGroupId);
	if (options.executionPid !== options.executionGroupId) {
		throw new TypeError(
			"execution pid and group id must identify the same POSIX group leader",
		);
	}
	if (options.executionBoundaryKind !== POSIX_EXECUTION_BOUNDARY_KIND) {
		throw new TypeError("unsupported execution boundary kind");
	}

	return runReconcilerTransaction(db, () => {
		const state = readReconcilerState(db);
		assertOwner(state.ownerToken, state.ownerPid, options);
		if (state.runningGeneration !== options.generation) {
			throw new ReconcilerFencedError(
				`running_generation ${String(state.runningGeneration)} does not match execution generation ${options.generation}`,
			);
		}
		if (state.activeExecution !== null) {
			throw new ReconcilerFencedError(
				"An active execution is already registered; refusing to register a second execution.",
			);
		}
		db.prepare(
			`UPDATE reconciler_state SET
				execution_token = ?,
				execution_generation = ?,
				execution_pid = ?,
				execution_process_identity = ?,
				execution_group_id = ?,
				execution_boundary_kind = ?,
				execution_owner_token = ?,
				execution_state = 'REGISTERED'
			 WHERE singleton_id = 1`,
		).run(
			options.executionToken,
			options.generation,
			options.executionPid,
			options.executionProcessIdentity,
			options.executionGroupId,
			options.executionBoundaryKind,
			options.ownerToken,
		);
		const registered = readReconcilerState(db).activeExecution;
		if (registered === null) {
			throw new ReconcilerFencedError(
				"Active execution registration did not persist.",
			);
		}
		return registered;
	});
}

/** Durably authorize START before sending it over IPC. */
export function authorizeActiveExecutionStart(
	db: DatabaseSync,
	options: FenceActiveExecutionOptions,
): boolean {
	return runReconcilerTransaction(db, () => {
		const state = readReconcilerState(db);
		assertOwner(state.ownerToken, state.ownerPid, options);
		if (
			state.activeExecution?.token !== options.executionToken ||
			state.activeExecution.ownerToken !== options.ownerToken
		) {
			return false;
		}
		if (state.activeExecution.state !== "REGISTERED") return false;
		const result = db
			.prepare(
				`UPDATE reconciler_state SET execution_state = 'START_AUTHORIZED'
				 WHERE singleton_id = 1 AND execution_token = ?`,
			)
			.run(options.executionToken);
		return result.changes === 1;
	});
}

/** Clear a proven-dead execution using owner and execution fencing. */
export function clearActiveExecution(
	db: DatabaseSync,
	options: FenceActiveExecutionOptions,
): boolean {
	return runReconcilerTransaction(db, () => {
		const state = readReconcilerState(db);
		assertOwner(state.ownerToken, state.ownerPid, options);
		if (state.activeExecution?.token !== options.executionToken) return false;
		const result = db
			.prepare(
				`UPDATE reconciler_state SET
					execution_token = NULL,
					execution_generation = NULL,
					execution_pid = NULL,
					execution_process_identity = NULL,
					execution_group_id = NULL,
					execution_boundary_kind = NULL,
					execution_owner_token = NULL,
					execution_state = NULL
				 WHERE singleton_id = 1 AND execution_token = ?`,
			)
			.run(options.executionToken);
		return result.changes === 1;
	});
}
