/**
 * Durable SQLite reconciliation state transitions.
 *
 * SQLite transactions contain only database reads and writes. Process liveness
 * is sampled before admission and the observed owner identity is rechecked
 * inside the write transaction before the decision is committed.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import type { DatabaseSync } from "node:sqlite";
import {
	type ReconcilerStateRecord,
	readReconcilerState,
} from "./reconciler-db.ts";

export class ReconcilerFencedError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ReconcilerFencedError";
	}
}

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

/** ESRCH means absent; EPERM proves that the process exists. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Boot epoch is retained as diagnostic metadata, not as liveness authority. */
export function currentBootEpochMs(): number {
	return Date.now() - Math.floor(os.uptime() * 1000);
}

/** Read a process-birth identity without invoking a shell. */
export function readProcessStartIdentity(pid: number): string | null {
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	try {
		if (process.platform === "linux") {
			const bootId = fs
				.readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
				.trim();
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
			const fieldsAfterCommand = stat
				.slice(stat.lastIndexOf(")") + 2)
				.split(" ");
			const startTicks = fieldsAfterCommand[19];
			return bootId && startTicks ? `linux-proc:${bootId}:${startTicks}` : null;
		}
		const processRecord = execFileSync(
			"ps",
			["-p", String(pid), "-o", "lstart=", "-o", "command="],
			{
				encoding: "utf8",
				env: { ...process.env, LC_ALL: "C" },
				stdio: ["ignore", "pipe", "ignore"],
			},
		).trim();
		return processRecord ? `ps-process:${processRecord}` : null;
	} catch {
		return null;
	}
}

/** Add a unique, non-secret launch marker before reading this process identity. */
export function establishCurrentProcessIdentity(nonce: string): string | null {
	if (!nonce.trim()) return null;
	process.title = `git-commits-push-${nonce}`;
	return readProcessStartIdentity(process.pid);
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
	// Failure to read metadata must not authorize stealing a live PID.
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

function ownerMatchesObservation(
	current: ReconcilerStateRecord,
	observed: ReconcilerStateRecord,
): boolean {
	return (
		current.ownerToken === observed.ownerToken &&
		current.ownerPid === observed.ownerPid &&
		current.ownerProcessIdentity === observed.ownerProcessIdentity &&
		current.runningGeneration === observed.runningGeneration
	);
}

function runTransaction<T>(db: DatabaseSync, operation: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const value = operation();
		db.exec("COMMIT");
		return value;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// Preserve the original failure when rollback is no longer possible.
		}
		throw error;
	}
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
			return runTransaction(db, () => {
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
						requested_generation = ?,
						running_generation = ?,
						owner_token = ?,
						owner_pid = ?,
						owner_boot_epoch_ms = ?,
						owner_process_identity = ?,
						owner_caller_name = ?,
						owner_origin_agent = ?,
						owner_session_id = ?,
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

/** Finalize one pass and atomically decide whether a newer generation follows. */
export function finishReconciliationPass(
	db: DatabaseSync,
	options: FinishReconciliationPassOptions,
): FinishReconciliationResult {
	return runTransaction(db, () => {
		const state = readReconcilerState(db);
		if (state.ownerToken !== options.token || state.ownerPid !== options.pid) {
			throw new ReconcilerFencedError(
				"The reconciler owner token no longer matches the coordinator state; refusing to finalize another owner's pass.",
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
				`UPDATE reconciler_state SET
					completed_generation = ?,
					running_generation = ?,
					heartbeat_at_epoch_ms = ?
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
			`UPDATE reconciler_state SET
				completed_generation = ?,
				running_generation = NULL,
				owner_token = NULL,
				owner_pid = NULL,
				owner_boot_epoch_ms = NULL,
				owner_process_identity = NULL,
				owner_caller_name = NULL,
				owner_origin_agent = NULL,
				owner_session_id = NULL,
				heartbeat_at_epoch_ms = NULL
			 WHERE singleton_id = 1`,
		).run(completedGeneration);
		return options.success
			? { decision: "STOP_SUCCESS", completedGeneration }
			: { decision: "STOP_FAILED", completedGeneration };
	});
}

/** Token-fenced heartbeat. Returns false after ownership replacement. */
export function heartbeatReconciler(
	db: DatabaseSync,
	options: HeartbeatOptions,
): boolean {
	const result = db
		.prepare(
			`UPDATE reconciler_state SET heartbeat_at_epoch_ms = ?
			 WHERE singleton_id = 1 AND owner_token = ? AND owner_pid = ?`,
		)
		.run(options.nowEpochMs, options.token, options.pid);
	return result.changes === 1;
}

/** Release interrupted ownership without advancing completed generation. */
export function releaseReconciliationOwnership(
	db: DatabaseSync,
	options: ReleaseOwnershipOptions,
): boolean {
	const result = db
		.prepare(
			`UPDATE reconciler_state SET
				running_generation = NULL,
				owner_token = NULL,
				owner_pid = NULL,
				owner_boot_epoch_ms = NULL,
				owner_process_identity = NULL,
				owner_caller_name = NULL,
				owner_origin_agent = NULL,
				owner_session_id = NULL,
				heartbeat_at_epoch_ms = NULL
			 WHERE singleton_id = 1 AND owner_token = ? AND owner_pid = ?`,
		)
		.run(options.token, options.pid);
	return result.changes === 1;
}
