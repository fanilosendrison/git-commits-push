/**
 * Owner tenure lifecycle: the fenced owner token, heartbeat, crash guards,
 * best-effort release, and resource cleanup for one reconciliation ownership
 * interval. A launcher process runs one or more tenures across wait retries
 * and recovery, always with a fresh token per tenure.
 */
import type { DatabaseSync } from "node:sqlite";
import type { LauncherCancellation } from "./launcher-cancellation.ts";
import {
	heartbeatReconciler,
	releaseReconciliationOwnership,
} from "./reconciler.ts";
import type { ReconciliationInvocationMode } from "./reconciler-state.ts";

const HEARTBEAT_INTERVAL_MS = 10_000;

export interface OwnerTenureOptions {
	readonly db: DatabaseSync;
	readonly cancellation: LauncherCancellation;
}

export interface OwnerTenure {
	readonly token: () => string | null;
	readonly mode: () => ReconciliationInvocationMode | null;
	readonly active: () => boolean;
	/** Begin a fresh, fenced owner tenure. */
	start(token: string, mode: ReconciliationInvocationMode): void;
	/** End tenure bookkeeping without touching durable ownership. */
	end(): void;
	/** Release durable ownership only when no active execution is recorded. */
	releaseBestEffort(): void;
	/** End the tenure, remove process guards, and close the database. */
	close(): void;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Install one owner tenure with a token-fenced heartbeat and crash guards. */
export function createOwnerTenure(options: OwnerTenureOptions): OwnerTenure {
	const { db, cancellation } = options;
	let ownerToken: string | null = null;
	let ownerMode: ReconciliationInvocationMode | null = null;
	let ownerActive = false;
	let heartbeat: NodeJS.Timeout | null = null;

	const releaseBestEffort = (): void => {
		if (!ownerActive || ownerToken === null || ownerMode === null) return;
		try {
			releaseReconciliationOwnership(db, {
				mode: ownerMode,
				pid: process.pid,
				token: ownerToken,
			});
		} catch {
			// Fencing prevents stale finalization if best-effort release fails.
		}
	};
	const end = (): void => {
		if (heartbeat !== null) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		ownerActive = false;
		ownerToken = null;
		ownerMode = null;
	};
	const start = (token: string, mode: ReconciliationInvocationMode): void => {
		ownerToken = token;
		ownerMode = mode;
		ownerActive = true;
		heartbeat = setInterval(() => {
			try {
				const retained = heartbeatReconciler(db, {
					nowEpochMs: Date.now(),
					pid: process.pid,
					token,
				});
				if (!retained) {
					cancellation.abortForOwnershipFailure(
						"reconciliation ownership was lost; active work was terminated",
					);
				}
			} catch (error) {
				cancellation.abortForOwnershipFailure(
					`reconciliation ownership was lost because heartbeat validation failed: ${errorMessage(error)}`,
				);
			}
		}, HEARTBEAT_INTERVAL_MS);
	};
	const crashWithoutFalseIdle = (reason: unknown): void => {
		process.stderr.write(
			`git-commits-push launcher crashed: ${errorMessage(reason)}\n`,
		);
		// Release succeeds only when no active execution is durably recorded.
		releaseBestEffort();
		try {
			db.close();
		} catch {
			// Connection may already be unusable.
		}
		process.exit(1);
	};
	process.on("uncaughtException", crashWithoutFalseIdle);
	process.on("unhandledRejection", crashWithoutFalseIdle);
	const close = (): void => {
		end();
		process.removeListener("uncaughtException", crashWithoutFalseIdle);
		process.removeListener("unhandledRejection", crashWithoutFalseIdle);
		cancellation.removeSignalHandlers();
		db.close();
	};
	return {
		active: () => ownerActive,
		close,
		end,
		mode: () => ownerMode,
		releaseBestEffort,
		start,
		token: () => ownerToken,
	};
}
