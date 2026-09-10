import type { DatabaseSync } from "node:sqlite";

export const POSIX_EXECUTION_BOUNDARY_KIND = "posix-session-process-group-v1";

export type ActiveExecutionState = "REGISTERED" | "START_AUTHORIZED";

export interface ActiveExecutionRecord {
	readonly token: string;
	readonly generation: number;
	readonly pid: number;
	readonly processIdentity: string;
	readonly groupId: number;
	readonly boundaryKind: typeof POSIX_EXECUTION_BOUNDARY_KIND;
	readonly ownerToken: string;
	readonly state: ActiveExecutionState;
}

export interface ReconcilerStateRecord {
	readonly singletonId: number;
	readonly requestedGeneration: number;
	readonly completedGeneration: number;
	readonly runningGeneration: number | null;
	readonly ownerToken: string | null;
	readonly ownerPid: number | null;
	readonly ownerBootEpochMs: number | null;
	readonly ownerProcessIdentity: string | null;
	readonly ownerCallerName: string | null;
	readonly ownerOriginAgent: string | null;
	readonly ownerSessionId: string | null;
	readonly heartbeatAtEpochMs: number | null;
	readonly activeExecution: ActiveExecutionRecord | null;
}

export class ReconcilerInvariantError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ReconcilerInvariantError";
	}
}

interface RawStateRow {
	readonly singleton_id: number;
	readonly requested_generation: number;
	readonly completed_generation: number;
	readonly running_generation: number | null;
	readonly owner_token: string | null;
	readonly owner_pid: number | null;
	readonly owner_boot_epoch_ms: number | null;
	readonly owner_process_identity: string | null;
	readonly owner_caller_name: string | null;
	readonly owner_origin_agent: string | null;
	readonly owner_session_id: string | null;
	readonly heartbeat_at_epoch_ms: number | null;
	readonly execution_token: string | null;
	readonly execution_generation: number | null;
	readonly execution_pid: number | null;
	readonly execution_process_identity: string | null;
	readonly execution_group_id: number | null;
	readonly execution_boundary_kind: string | null;
	readonly execution_owner_token: string | null;
	readonly execution_state: string | null;
}

function isSafeNonNegativeInteger(value: number | null): value is number {
	return value !== null && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: number | null): value is number {
	return isSafeNonNegativeInteger(value) && value !== 0;
}

function isNonEmpty(value: string | null): value is string {
	return value !== null && value.trim().length > 0;
}

function readActiveExecution(
	row: RawStateRow,
	ownerToken: string | null,
	runningGeneration: number | null,
	completedGeneration: number,
): ActiveExecutionRecord | null {
	const values = [
		row.execution_token,
		row.execution_generation,
		row.execution_pid,
		row.execution_process_identity,
		row.execution_group_id,
		row.execution_boundary_kind,
		row.execution_owner_token,
		row.execution_state,
	];
	const presentCount = values.filter((value) => value !== null).length;
	if (presentCount === 0) return null;
	if (presentCount !== values.length) {
		throw new ReconcilerInvariantError(
			"active execution fields must be set and cleared together",
		);
	}
	if (ownerToken === null || runningGeneration === null) {
		throw new ReconcilerInvariantError(
			"an active execution requires an active reconciliation owner",
		);
	}
	const executionGeneration = row.execution_generation;
	const executionPid = row.execution_pid;
	const executionGroupId = row.execution_group_id;
	if (
		!isSafeNonNegativeInteger(executionGeneration) ||
		executionGeneration <= completedGeneration ||
		executionGeneration > runningGeneration
	) {
		throw new ReconcilerInvariantError(
			`execution_generation (${String(row.execution_generation)}) must be > completed_generation (${completedGeneration}) and <= running_generation (${runningGeneration})`,
		);
	}
	if (
		!isPositiveInteger(executionPid) ||
		!isPositiveInteger(executionGroupId) ||
		executionPid !== executionGroupId
	) {
		throw new ReconcilerInvariantError(
			"execution pid and process-group id must be the same positive integer",
		);
	}
	if (
		!isNonEmpty(row.execution_token) ||
		!isNonEmpty(row.execution_process_identity) ||
		!isNonEmpty(row.execution_owner_token)
	) {
		throw new ReconcilerInvariantError(
			"active execution tokens and process identity must be non-empty",
		);
	}
	if (row.execution_boundary_kind !== POSIX_EXECUTION_BOUNDARY_KIND) {
		throw new ReconcilerInvariantError(
			`unsupported execution boundary kind: ${String(row.execution_boundary_kind)}`,
		);
	}
	if (
		row.execution_state !== "REGISTERED" &&
		row.execution_state !== "START_AUTHORIZED"
	) {
		throw new ReconcilerInvariantError(
			`invalid active execution state: ${String(row.execution_state)}`,
		);
	}
	const sameOwner = row.execution_owner_token === ownerToken;
	const sameGeneration = row.execution_generation === runningGeneration;
	if (sameOwner !== sameGeneration) {
		throw new ReconcilerInvariantError(
			"an execution belongs either to the current running owner or to an older generation under explicit recovery",
		);
	}
	return {
		boundaryKind: POSIX_EXECUTION_BOUNDARY_KIND,
		generation: executionGeneration,
		groupId: executionGroupId,
		ownerToken: row.execution_owner_token,
		pid: executionPid,
		processIdentity: row.execution_process_identity,
		state: row.execution_state,
		token: row.execution_token,
	};
}

/** Read and fail-closed validate the bounded singleton coordinator row. */
export function readReconcilerState(db: DatabaseSync): ReconcilerStateRecord {
	const rows = db
		.prepare("SELECT * FROM reconciler_state")
		.all() as unknown as RawStateRow[];
	if (rows.length !== 1) {
		throw new ReconcilerInvariantError(
			`reconciler_state must contain exactly one row, found ${rows.length}`,
		);
	}
	const row = rows[0] as RawStateRow;
	if (row.singleton_id !== 1) {
		throw new ReconcilerInvariantError(
			`reconciler_state singleton_id must be 1, found ${row.singleton_id}`,
		);
	}
	if (!isSafeNonNegativeInteger(row.requested_generation)) {
		throw new ReconcilerInvariantError(
			`reconciler_state requested_generation is invalid: ${String(row.requested_generation)}`,
		);
	}
	if (!isSafeNonNegativeInteger(row.completed_generation)) {
		throw new ReconcilerInvariantError(
			`reconciler_state completed_generation is invalid: ${String(row.completed_generation)}`,
		);
	}
	if (row.requested_generation < row.completed_generation) {
		throw new ReconcilerInvariantError(
			`requested_generation (${row.requested_generation}) must be >= completed_generation (${row.completed_generation})`,
		);
	}

	const hasRunning = row.running_generation !== null;
	const ownerFields = [
		row.owner_token,
		row.owner_pid,
		row.owner_boot_epoch_ms,
		row.owner_process_identity,
		row.owner_caller_name,
		row.owner_origin_agent,
	];
	if (ownerFields.some((value) => (value !== null) !== hasRunning)) {
		throw new ReconcilerInvariantError(
			"owner token, pid, boot epoch, process identity, caller, origin and running generation must be set and cleared together",
		);
	}
	if (!hasRunning && row.owner_session_id !== null) {
		throw new ReconcilerInvariantError(
			"owner session id must be cleared when no owner is active",
		);
	}
	if (hasRunning) {
		if (
			!isSafeNonNegativeInteger(row.running_generation) ||
			row.running_generation <= row.completed_generation ||
			row.running_generation > row.requested_generation
		) {
			throw new ReconcilerInvariantError(
				`running_generation (${String(row.running_generation)}) must be > completed_generation (${row.completed_generation}) and <= requested_generation (${row.requested_generation})`,
			);
		}
		if (
			!isSafeNonNegativeInteger(row.owner_boot_epoch_ms) ||
			!isPositiveInteger(row.owner_pid) ||
			!isSafeNonNegativeInteger(row.heartbeat_at_epoch_ms) ||
			!isNonEmpty(row.owner_token) ||
			!isNonEmpty(row.owner_process_identity) ||
			!isNonEmpty(row.owner_caller_name) ||
			!isNonEmpty(row.owner_origin_agent) ||
			(row.owner_session_id !== null && !isNonEmpty(row.owner_session_id))
		) {
			throw new ReconcilerInvariantError(
				"active owner metadata must contain a heartbeat and valid non-empty identity fields",
			);
		}
	} else if (row.heartbeat_at_epoch_ms !== null) {
		throw new ReconcilerInvariantError(
			"heartbeat_at_epoch_ms must be cleared when no owner is active",
		);
	}

	return {
		activeExecution: readActiveExecution(
			row,
			row.owner_token,
			row.running_generation,
			row.completed_generation,
		),
		completedGeneration: row.completed_generation,
		heartbeatAtEpochMs: row.heartbeat_at_epoch_ms,
		ownerBootEpochMs: row.owner_boot_epoch_ms,
		ownerCallerName: row.owner_caller_name,
		ownerOriginAgent: row.owner_origin_agent,
		ownerPid: row.owner_pid,
		ownerProcessIdentity: row.owner_process_identity,
		ownerSessionId: row.owner_session_id,
		ownerToken: row.owner_token,
		requestedGeneration: row.requested_generation,
		runningGeneration: row.running_generation,
		singletonId: row.singleton_id,
	};
}
