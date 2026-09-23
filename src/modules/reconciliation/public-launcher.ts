import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { parseInvocationArguments } from "../invocation/invocation-scope.ts";
import { resolveRequestIdentity } from "../orders/request-identity.ts";
import {
	createSkillStatsLog,
	type SkillStatsLog,
} from "../telemetry/stats-logger.ts";
import {
	admitReconciliationRequest,
	type NonWaitRegistration,
} from "./admission-wait.ts";
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
	type OwnedReconciliationResult,
	type RuntimePreparationResult,
	recoverPriorExecutionForOwner,
	runOwnedReconciliation,
} from "./owned-reconciliation-loop.ts";
import { createOwnerTenure } from "./owner-tenure.ts";
import {
	establishCurrentProcessIdentity,
	releaseReconciliationOwnership,
} from "./reconciler.ts";
import {
	openReconcilerDb,
	ReconcilerInvariantError,
	ReconcilerOpenError,
	type ReconciliationInvocationMode,
	resolveApplicationStateDirectory,
	resolveReconcilerDbPath,
	resolveReconcilerStateDirectory,
} from "./reconciler-db.ts";
import {
	acquireStateCutoverLock,
	releaseStateCutoverLock,
} from "./state-cutover-lock.ts";

export type { RuntimePreparationResult } from "./owned-reconciliation-loop.ts";

export interface RunPublicLauncherOptions {
	readonly compiledApplicationDirectory: string;
	readonly passthroughArguments?: readonly string[];
	readonly prepareRuntime?: (
		abortSignal: AbortSignal,
	) => Promise<RuntimePreparationResult>;
}

type AdmissionResult =
	| {
			readonly kind: "admitted";
			readonly registration: NonWaitRegistration;
			readonly token: string;
	  }
	| { readonly kind: "failed" }
	| { readonly kind: "interrupted" };

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
	const externalArguments = options.passthroughArguments ?? [];
	let invocationMode: ReconciliationInvocationMode;
	try {
		invocationMode = parseInvocationArguments(externalArguments).request.kind;
	} catch (error) {
		failClosed(`invalid invocation arguments: ${errorMessage(error)}`);
		return 2;
	}

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

	const processMarkerNonce = randomBytes(16).toString("hex");
	const ownerProcessIdentity =
		establishCurrentProcessIdentity(processMarkerNonce);
	if (!ownerProcessIdentity) {
		releaseStateCutoverLockBeforeReturn();
		failClosed("cannot read the launcher process start identity");
		db.close();
		return 2;
	}
	const cancellation = createLauncherCancellation();
	const tenure = createOwnerTenure({ cancellation, db });

	const terminateForInterruptedWait = (): number => {
		cancellation.removeSignalHandlers();
		db.close();
		const interruptedSignal = cancellation.interruptedSignal;
		if (interruptedSignal !== null) {
			process.kill(process.pid, interruptedSignal);
		}
		return 2;
	};

	/** Admit one request, polling process-locally while an incompatible owner runs. */
	const admitRequest = async (): Promise<AdmissionResult> => {
		const outcome = await admitReconciliationRequest({
			callerName: identity.callerName,
			db,
			isInterrupted: () => cancellation.interruptedSignal !== null,
			mode: invocationMode,
			onAttempt: releaseStateCutoverLockBeforeReturn,
			...(identity.originSessionId === undefined
				? {}
				: { originSessionId: identity.originSessionId }),
			originAgent: identity.originAgent,
			processIdentity: ownerProcessIdentity,
		});
		if (outcome.kind === "failed") {
			cancellation.removeSignalHandlers();
			failClosed(
				`reconciliation admission failed: ${errorMessage(outcome.error)}`,
			);
			db.close();
			return { kind: "failed" };
		}
		if (outcome.kind === "interrupted") return { kind: "interrupted" };
		return {
			kind: "admitted",
			registration: outcome.registration,
			token: outcome.token,
		};
	};

	const terminateAfterCancellation = (): number => {
		tenure.releaseBestEffort();
		tenure.close();
		if (cancellation.interruptedSignal !== null) {
			process.kill(process.pid, cancellation.interruptedSignal);
		}
		failClosed(
			cancellation.ownershipFailure ?? "reconciliation ownership was lost",
		);
		return 2;
	};
	const failTenure = (message: string, error: unknown): number => {
		tenure.releaseBestEffort();
		tenure.close();
		failClosed(
			cancellation.ownershipFailure ?? `${message}: ${errorMessage(error)}`,
		);
		return 2;
	};

	let admission = await admitRequest();
	if (admission.kind === "failed") return 2;
	if (admission.kind === "interrupted") return terminateForInterruptedWait();
	let registration = admission.registration;
	let registrationToken = admission.token;
	let legacyArtifactsDeleted = false;

	for (;;) {
		if (registration.kind === "COALESCED") {
			const coalesced = registration;
			logTelemetry((log) =>
				log.logReconciliationRequested({
					callerName: identity.callerName,
					generation: coalesced.generation,
					originAgent: identity.originAgent,
					...(identity.originSessionId === undefined
						? {}
						: { originSessionId: identity.originSessionId }),
					outcome: "coalesced",
				}),
			);
			logTelemetry((log) =>
				log.logReconciliationCoalesced({
					generation: coalesced.generation,
					ownerCallerName: coalesced.ownerCallerName,
					ownerPid: coalesced.ownerPid,
				}),
			);
			writeCoalescedMessage(coalesced.generation);
			tenure.close();
			return 0;
		}

		tenure.start(
			registrationToken,
			registration.kind === "OWNER"
				? registration.mode
				: registration.recoveryMode,
		);
		await new Promise((resolve) => setImmediate(resolve));
		if (cancellation.interruptedSignal !== null) {
			tenure.releaseBestEffort();
			tenure.close();
			process.kill(process.pid, cancellation.interruptedSignal);
			return 2;
		}

		logTelemetry((log) =>
			log.logReconciliationRequested({
				callerName: identity.callerName,
				generation: registration.generation,
				originAgent: identity.originAgent,
				...(identity.originSessionId === undefined
					? {}
					: { originSessionId: identity.originSessionId }),
				outcome: "owner",
				recovered: registration.kind === "RECOVERY_OWNER",
			}),
		);
		if (registration.kind === "RECOVERY_OWNER") {
			const recovered = registration;
			process.stderr.write(
				`git-commits-push: recovered ${recovered.recoveryMode} reconciliation state from a previous owner ` +
					`(pid ${recovered.previousOwnerPid ?? "none"}).\n`,
			);
			logTelemetry((log) =>
				log.logReconciliationRecovered({
					generation: recovered.generation,
					previousOwnerPid: recovered.previousOwnerPid,
				}),
			);
		}

		if (!legacyArtifactsDeleted) {
			try {
				deleteLegacyQueueArtifacts(stateDirectory, legacyInspection);
				legacyArtifactsDeleted = true;
			} catch (error) {
				return failTenure("legacy queue migration failed", error);
			}
		}

		if (registration.kind === "OWNER") {
			let result: OwnedReconciliationResult;
			try {
				result = await runOwnedReconciliation({
					cancellation,
					compiledApplicationDirectory: options.compiledApplicationDirectory,
					db,
					initialGeneration: registration.generation,
					mode: registration.mode,
					ownerToken: registrationToken,
					passthroughArguments: externalArguments,
					...(options.prepareRuntime === undefined
						? {}
						: { prepareRuntime: options.prepareRuntime }),
				});
			} catch (error) {
				return failTenure("reconciliation execution failed", error);
			}
			if (result.cancelled) return terminateAfterCancellation();
			tenure.close();
			return result.exitCode;
		}

		if (registration.recoveryMode === "global") {
			const requestSatisfied = registration.requestSatisfiedByRecovery;
			let result: OwnedReconciliationResult;
			try {
				result = await runOwnedReconciliation({
					cancellation,
					compiledApplicationDirectory: options.compiledApplicationDirectory,
					db,
					initialGeneration: registration.generation,
					mode: "global",
					ownerToken: registrationToken,
					passthroughArguments: requestSatisfied ? externalArguments : [],
					...(options.prepareRuntime === undefined
						? {}
						: { prepareRuntime: options.prepareRuntime }),
				});
			} catch (error) {
				return failTenure("reconciliation recovery failed", error);
			}
			if (result.cancelled) return terminateAfterCancellation();
			if (requestSatisfied || result.exitCode !== 0) {
				tenure.close();
				return result.exitCode;
			}
			tenure.end();
		} else {
			try {
				await recoverPriorExecutionForOwner(db, registrationToken);
				const settled = releaseReconciliationOwnership(db, {
					mode: "targeted",
					pid: process.pid,
					token: registrationToken,
				});
				if (!settled) {
					throw new Error(
						"targeted recovery could not durably settle the coordinator generation",
					);
				}
			} catch (error) {
				return failTenure("targeted recovery failed", error);
			}
			tenure.end();
		}

		admission = await admitRequest();
		if (admission.kind === "failed") return 2;
		if (admission.kind === "interrupted") return terminateForInterruptedWait();
		registration = admission.registration;
		registrationToken = admission.token;
	}
}
