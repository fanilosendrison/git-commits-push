import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { resolveRequestIdentity } from "../orders/request-identity.ts";
import {
	createSkillStatsLog,
	type SkillStatsLog,
} from "../telemetry/stats-logger.ts";
import { createLauncherCancellation } from "./launcher-cancellation.ts";
import {
	failClosed,
	writeCoalescedMessage,
	writeLiveLegacyWorkerMessage,
	writeMalformedLegacyLockMessage,
} from "./launcher-messages.ts";
import {
	deleteLegacyQueueArtifacts,
	inspectLegacyQueueState,
} from "./legacy-queue-state.ts";
import { assertLegacyApplicationStateMigrated } from "./legacy-state-cutover.ts";
import {
	currentBootEpochMs,
	establishCurrentProcessIdentity,
	finishReconciliationPass,
	heartbeatReconciler,
	registerReconciliationRequest,
	releaseReconciliationOwnership,
} from "./reconciler.ts";
import {
	openReconcilerDb,
	ReconcilerInvariantError,
	ReconcilerOpenError,
	resolveApplicationStateDirectory,
	resolveReconcilerDbPath,
	resolveReconcilerStateDirectory,
} from "./reconciler-db.ts";
import {
	acquireStateCutoverLock,
	releaseStateCutoverLock,
} from "./state-cutover-lock.ts";

const HEARTBEAT_INTERVAL_MS = 10_000;

export interface RuntimePreparationResult {
	readonly exitCode: number | null;
	readonly signal?: NodeJS.Signals | null;
}

export interface RunPublicLauncherOptions {
	readonly compiledApplicationDirectory: string;
	readonly passthroughArguments?: readonly string[];
	readonly prepareRuntime?: (
		abortSignal: AbortSignal,
	) => Promise<RuntimePreparationResult>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function logTelemetry(operation: (log: SkillStatsLog) => void): void {
	try {
		operation(createSkillStatsLog());
	} catch {
		// Telemetry must never block or crash reconciliation.
	}
}

/**
 * Own one public reconciliation invocation from admission through final release.
 * The optional preparation callback is development-only and can run only after
 * this process has become the fenced owner.
 */
export async function runPublicLauncher(
	options: RunPublicLauncherOptions,
): Promise<number> {
	const identity = resolveRequestIdentity();
	let stateCutoverLockPath: string | null = null;
	const releaseStateCutoverLockBeforeReturn = (): void => {
		if (stateCutoverLockPath === null) return;
		releaseStateCutoverLock(stateCutoverLockPath);
		stateCutoverLockPath = null;
	};
	if (process.env.ORDER_STATE_DIR === undefined) {
		try {
			stateCutoverLockPath = acquireStateCutoverLock(
				resolveApplicationStateDirectory(process.env),
			);
		} catch (error) {
			failClosed(errorMessage(error));
			return 2;
		}
	}

	try {
		assertLegacyApplicationStateMigrated();
	} catch (error) {
		releaseStateCutoverLockBeforeReturn();
		failClosed(errorMessage(error));
		return 2;
	}
	const stateDirectory = resolveReconcilerStateDirectory(process.env);
	let legacyInspection: ReturnType<typeof inspectLegacyQueueState>;
	try {
		legacyInspection = inspectLegacyQueueState(stateDirectory);
	} catch (error) {
		releaseStateCutoverLockBeforeReturn();
		failClosed(
			`reconciliation state directory is unreadable: ${errorMessage(error)}`,
		);
		return 2;
	}
	if (legacyInspection.lock === "live") {
		releaseStateCutoverLockBeforeReturn();
		writeLiveLegacyWorkerMessage();
		return 2;
	}
	if (legacyInspection.lock === "malformed") {
		releaseStateCutoverLockBeforeReturn();
		writeMalformedLegacyLockMessage();
		return 2;
	}

	fs.mkdirSync(stateDirectory, { recursive: true });
	let db: ReturnType<typeof openReconcilerDb>;
	try {
		db = openReconcilerDb(resolveReconcilerDbPath(stateDirectory));
	} catch (error) {
		releaseStateCutoverLockBeforeReturn();
		if (
			error instanceof ReconcilerOpenError ||
			error instanceof ReconcilerInvariantError
		) {
			failClosed(errorMessage(error));
			return 2;
		}
		throw error;
	}

	const ownerToken = randomBytes(16).toString("hex");
	const ownerProcessIdentity = establishCurrentProcessIdentity(ownerToken);
	if (!ownerProcessIdentity) {
		releaseStateCutoverLockBeforeReturn();
		failClosed("cannot read the launcher process start identity");
		db.close();
		return 2;
	}
	let ownerActive = false;
	const cancellation = createLauncherCancellation();
	let registration: ReturnType<typeof registerReconciliationRequest>;
	try {
		registration = registerReconciliationRequest(db, {
			bootEpochMs: currentBootEpochMs(),
			callerName: identity.callerName,
			nowEpochMs: Date.now(),
			originAgent: identity.originAgent,
			...(identity.originSessionId === undefined
				? {}
				: { originSessionId: identity.originSessionId }),
			pid: process.pid,
			processIdentity: ownerProcessIdentity,
			token: ownerToken,
		});
	} catch (error) {
		releaseStateCutoverLockBeforeReturn();
		cancellation.removeSignalHandlers();
		failClosed(`reconciliation admission failed: ${errorMessage(error)}`);
		db.close();
		return 2;
	}
	ownerActive = registration.kind === "OWNER";
	const releaseOwnershipBestEffort = (): void => {
		if (!ownerActive) return;
		try {
			releaseReconciliationOwnership(db, {
				pid: process.pid,
				token: ownerToken,
			});
		} catch {
			// Fencing prevents stale finalization if best-effort release fails.
		}
	};

	releaseStateCutoverLockBeforeReturn();
	await new Promise((resolve) => setImmediate(resolve));
	if (cancellation.interruptedSignal !== null) {
		releaseOwnershipBestEffort();
		cancellation.removeSignalHandlers();
		db.close();
		process.kill(process.pid, cancellation.interruptedSignal);
	}

	logTelemetry((log) =>
		log.logReconciliationRequested({
			callerName: identity.callerName,
			generation: registration.generation,
			originAgent: identity.originAgent,
			...(identity.originSessionId === undefined
				? {}
				: { originSessionId: identity.originSessionId }),
			outcome: registration.kind === "OWNER" ? "owner" : "coalesced",
			...(registration.kind === "OWNER"
				? { recovered: registration.recovered }
				: {}),
		}),
	);
	if (registration.kind === "COALESCED") {
		logTelemetry((log) =>
			log.logReconciliationCoalesced({
				generation: registration.generation,
				ownerCallerName: registration.ownerCallerName,
				ownerPid: registration.ownerPid,
			}),
		);
		writeCoalescedMessage(registration.generation);
		cancellation.removeSignalHandlers();
		db.close();
		return 0;
	}

	let heartbeat: NodeJS.Timeout | null = null;
	let uncaughtExceptionHandler: ((error: Error) => void) | null = null;
	const closeOwnerResources = (): void => {
		ownerActive = false;
		if (heartbeat !== null) clearInterval(heartbeat);
		if (uncaughtExceptionHandler !== null) {
			process.removeListener("uncaughtException", uncaughtExceptionHandler);
		}
		cancellation.removeSignalHandlers();
		db.close();
	};
	uncaughtExceptionHandler = (error: Error): void => {
		process.stderr.write(
			`git-commits-push launcher crashed: ${errorMessage(error)}\n`,
		);
		releaseOwnershipBestEffort();
		try {
			db.close();
		} catch {
			// Connection may already be unusable.
		}
		process.exit(1);
	};
	process.on("uncaughtException", uncaughtExceptionHandler);

	try {
		deleteLegacyQueueArtifacts(stateDirectory, legacyInspection);
	} catch (error) {
		releaseOwnershipBestEffort();
		closeOwnerResources();
		failClosed(`legacy queue migration failed: ${errorMessage(error)}`);
		return 2;
	}
	if (registration.recovered) {
		process.stderr.write(
			`git-commits-push: recovered reconciliation state from a previous owner ` +
				`(pid ${registration.previousOwnerPid}). Performing a fresh global rescan.\n`,
		);
		logTelemetry((log) =>
			log.logReconciliationRecovered({
				generation: registration.generation,
				previousOwnerPid: registration.previousOwnerPid,
			}),
		);
	}

	heartbeat = setInterval(() => {
		try {
			const retained = heartbeatReconciler(db, {
				nowEpochMs: Date.now(),
				pid: process.pid,
				token: ownerToken,
			});
			if (!retained) {
				cancellation.abortForOwnershipFailure(
					"reconciliation ownership was lost; active work was terminated",
				);
			}
		} catch (error) {
			cancellation.abortForOwnershipFailure(
				`reconciliation heartbeat failed: ${errorMessage(error)}`,
			);
		}
	}, HEARTBEAT_INTERVAL_MS);

	const terminateAfterCancellation = (): number => {
		releaseOwnershipBestEffort();
		closeOwnerResources();
		if (cancellation.interruptedSignal !== null) {
			process.kill(process.pid, cancellation.interruptedSignal);
		}
		failClosed(
			cancellation.ownershipFailure ?? "reconciliation ownership was lost",
		);
		return 2;
	};

	if (options.prepareRuntime !== undefined) {
		const preparation = await options.prepareRuntime(cancellation.signal);
		if (cancellation.signal.aborted) return terminateAfterCancellation();
		if (preparation.exitCode !== 0) {
			const finish = finishReconciliationPass(db, {
				generation: registration.generation,
				nowEpochMs: Date.now(),
				pid: process.pid,
				success: false,
				token: ownerToken,
			});
			if (finish.decision === "CONTINUE") releaseOwnershipBestEffort();
			closeOwnerResources();
			return preparation.exitCode ?? 1;
		}
	}

	const { runSupervisorPass } = await import("./supervisor-pass.ts");
	let generation = registration.generation;
	let finalExitCode = 0;
	while (true) {
		logTelemetry((log) => log.logReconciliationPassStarted({ generation }));
		const pass = await runSupervisorPass({
			abortSignal: cancellation.signal,
			compiledApplicationDirectory: options.compiledApplicationDirectory,
			passthroughArguments: options.passthroughArguments ?? [],
		});
		if (cancellation.signal.aborted) return terminateAfterCancellation();
		const success =
			pass.spawnError === null && pass.signal === null && pass.exitCode === 0;
		const finish = finishReconciliationPass(db, {
			generation,
			nowEpochMs: Date.now(),
			pid: process.pid,
			success,
			token: ownerToken,
		});
		logTelemetry((log) =>
			log.logReconciliationPassFinished({
				decision: finish.decision,
				exitCode: pass.exitCode ?? 1,
				generation,
				success,
			}),
		);
		if (finish.decision === "CONTINUE") {
			generation = finish.generation;
			continue;
		}
		if (finish.decision === "STOP_SUCCESS") {
			logTelemetry((log) =>
				log.logReconciliationIdle({
					generation: finish.completedGeneration,
				}),
			);
		}
		finalExitCode = success ? 0 : (pass.exitCode ?? 1);
		break;
	}
	closeOwnerResources();
	return finalExitCode;
}
