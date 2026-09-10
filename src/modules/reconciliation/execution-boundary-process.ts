import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
	isProcessAlive,
	readProcessStartIdentity,
} from "./process-identity.ts";
import type { ActiveExecutionRecord } from "./reconciler-state.ts";

export const EXECUTION_TERMINATION_GRACE_MS = 5_000;
export const EXECUTION_TERMINATION_CONFIRMATION_MS = 5_000;
const LIVENESS_POLL_MS = 20;

export type ExecutionBoundaryLiveness = "alive-exact" | "dead" | "ambiguous";

export class ExecutionBoundaryError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ExecutionBoundaryError";
	}
}

export function platformSupportsExecutionBoundary(): boolean {
	return process.platform === "darwin" || process.platform === "linux";
}

/** Independently verify the PGID of a process without a shell. */
export function readProcessGroupId(pid: number): number | null {
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	try {
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
			const fieldsAfterCommand = stat
				.slice(stat.lastIndexOf(")") + 2)
				.split(" ");
			const groupId = Number.parseInt(fieldsAfterCommand[2] ?? "", 10);
			return Number.isSafeInteger(groupId) && groupId > 0 ? groupId : null;
		}
		const output = execFileSync("/bin/ps", ["-p", String(pid), "-o", "pgid="], {
			encoding: "utf8",
			env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const groupId = Number.parseInt(output, 10);
		return Number.isSafeInteger(groupId) && groupId > 0 ? groupId : null;
	} catch {
		return null;
	}
}

/** Signal 0 checks whether at least one process still belongs to this PGID. */
export function processGroupExists(groupId: number): boolean {
	if (!Number.isSafeInteger(groupId) || groupId <= 0) {
		throw new TypeError("process group id must be a positive integer");
	}
	try {
		process.kill(-groupId, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		throw error;
	}
}

/** Classify without ever signaling a reused or otherwise ambiguous PID/PGID. */
export function classifyExecutionBoundary(
	execution: ActiveExecutionRecord,
): ExecutionBoundaryLiveness {
	if (!platformSupportsExecutionBoundary()) return "ambiguous";
	const groupExists = processGroupExists(execution.groupId);
	if (!isProcessAlive(execution.pid)) return groupExists ? "ambiguous" : "dead";
	const identity = readProcessStartIdentity(execution.pid);
	if (identity === null) return "ambiguous";
	if (identity !== execution.processIdentity) {
		return groupExists ? "ambiguous" : "dead";
	}
	const currentGroupId = readProcessGroupId(execution.pid);
	if (currentGroupId === null || currentGroupId !== execution.groupId) {
		return "ambiguous";
	}
	return groupExists ? "alive-exact" : "ambiguous";
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForGroupAbsence(
	groupId: number,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (processGroupExists(groupId)) {
		if (Date.now() >= deadline) return false;
		await delay(LIVENESS_POLL_MS);
	}
	return true;
}

function signalVerifiedGroup(
	execution: ActiveExecutionRecord,
	signal: NodeJS.Signals,
): "signalled" | "already-dead" {
	const liveness = classifyExecutionBoundary(execution);
	if (liveness === "dead") return "already-dead";
	if (liveness !== "alive-exact") {
		throw new ExecutionBoundaryError(
			`Execution ${execution.token} lost its exact leader identity before ${signal}; refusing to signal an unrelated process group.`,
		);
	}
	try {
		process.kill(-execution.groupId, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		return "already-dead";
	}
	return "signalled";
}

/** Gracefully terminate, escalate, and prove complete process-group absence. */
export async function terminateExecutionBoundary(
	execution: ActiveExecutionRecord,
	options: {
		readonly graceMs?: number;
		readonly confirmationMs?: number;
	} = {},
): Promise<void> {
	const initial = classifyExecutionBoundary(execution);
	if (initial === "dead") return;
	if (initial === "ambiguous") {
		throw new ExecutionBoundaryError(
			`Execution ${execution.token} has an ambiguous PID or process-group identity; recovery is fail-closed.`,
		);
	}

	if (signalVerifiedGroup(execution, "SIGTERM") === "already-dead") return;
	if (
		await waitForGroupAbsence(
			execution.groupId,
			options.graceMs ?? EXECUTION_TERMINATION_GRACE_MS,
		)
	) {
		return;
	}
	if (signalVerifiedGroup(execution, "SIGKILL") === "already-dead") return;
	if (
		await waitForGroupAbsence(
			execution.groupId,
			options.confirmationMs ?? EXECUTION_TERMINATION_CONFIRMATION_MS,
		)
	) {
		return;
	}
	throw new ExecutionBoundaryError(
		`Execution process group ${execution.groupId} remains alive after hard termination; durable execution state is preserved.`,
	);
}
