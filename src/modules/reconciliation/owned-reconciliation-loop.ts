import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SkillStatsLog } from "../telemetry/stats-logger.ts";
import { createSkillStatsLog } from "../telemetry/stats-logger.ts";
import { terminateExecutionBoundary } from "./execution-boundary-process.ts";
import {
	recordExecutionTestEvent,
	waitForExecutionRegisteredTestBarrier,
} from "./execution-test-observer.ts";
import type { LauncherCancellation } from "./launcher-cancellation.ts";
import {
	authorizeActiveExecutionStart,
	clearActiveExecution,
	finishReconciliationPass,
	registerActiveExecution,
} from "./reconciler.ts";
import {
	POSIX_EXECUTION_BOUNDARY_KIND,
	readReconcilerState,
} from "./reconciler-db.ts";
import {
	prepareSupervisorPass,
	type SupervisorPassResult,
} from "./supervisor-pass.ts";

export interface RuntimePreparationResult {
	readonly exitCode: number | null;
	readonly signal?: NodeJS.Signals | null;
}

export interface RunOwnedReconciliationOptions {
	readonly db: DatabaseSync;
	readonly ownerToken: string;
	readonly initialGeneration: number;
	readonly compiledApplicationDirectory: string;
	readonly passthroughArguments: readonly string[];
	readonly cancellation: LauncherCancellation;
	readonly prepareRuntime?: (
		abortSignal: AbortSignal,
	) => Promise<RuntimePreparationResult>;
}

export interface OwnedReconciliationResult {
	readonly exitCode: number;
	readonly cancelled: boolean;
}

function logTelemetry(operation: (log: SkillStatsLog) => void): void {
	try {
		operation(createSkillStatsLog());
	} catch {
		// Telemetry is never correctness authority.
	}
}

function ownerFence(ownerToken: string, executionToken: string) {
	return {
		executionToken,
		ownerPid: process.pid,
		ownerToken,
	};
}

async function recoverPriorExecution(
	db: DatabaseSync,
	ownerToken: string,
): Promise<void> {
	const execution = readReconcilerState(db).activeExecution;
	if (execution === null) return;
	logTelemetry((log) =>
		log.logOrphanExecutionDetected({
			executionGeneration: execution.generation,
			executionPid: execution.pid,
		}),
	);
	logTelemetry((log) =>
		log.logOrphanExecutionTerminationStarted({ executionPid: execution.pid }),
	);
	await terminateExecutionBoundary(execution);
	if (!clearActiveExecution(db, ownerFence(ownerToken, execution.token))) {
		throw new Error(
			"prior execution died but its token-fenced durable record could not be cleared",
		);
	}
	logTelemetry((log) =>
		log.logOrphanExecutionTerminated({ executionPid: execution.pid }),
	);
}

async function terminatePreparedExecution(
	prepared: Awaited<ReturnType<typeof prepareSupervisorPass>>,
): Promise<void> {
	await prepared.terminate();
}

function passSucceeded(pass: SupervisorPassResult): boolean {
	return (
		pass.spawnError === null && pass.signal === null && pass.exitCode === 0
	);
}

async function runOnePass(
	options: RunOwnedReconciliationOptions,
	generation: number,
): Promise<SupervisorPassResult> {
	const executionToken = randomBytes(16).toString("hex");
	const prepared = await prepareSupervisorPass({
		compiledApplicationDirectory: options.compiledApplicationDirectory,
		executionToken,
		passthroughArguments: options.passthroughArguments,
	});
	logTelemetry((log) =>
		log.logExecutionPrepared({ executionPid: prepared.pid, generation }),
	);
	let registered = false;
	try {
		if (options.cancellation.signal.aborted) {
			await terminatePreparedExecution(prepared);
			return {
				exitCode: null,
				signal: "SIGTERM",
				spawnError: null,
				supervisorPid: null,
			};
		}
		registerActiveExecution(options.db, {
			executionBoundaryKind: POSIX_EXECUTION_BOUNDARY_KIND,
			executionGroupId: prepared.groupId,
			executionPid: prepared.pid,
			executionProcessIdentity: prepared.processIdentity,
			executionToken,
			generation,
			ownerPid: process.pid,
			ownerToken: options.ownerToken,
		});
		registered = true;
		logTelemetry((log) =>
			log.logExecutionRegistered({ executionPid: prepared.pid, generation }),
		);
		recordExecutionTestEvent("launcher_execution_registered", {
			executionToken,
			generation,
		});
		await waitForExecutionRegisteredTestBarrier();
		if (options.cancellation.signal.aborted) {
			await terminatePreparedExecution(prepared);
			if (
				!clearActiveExecution(
					options.db,
					ownerFence(options.ownerToken, executionToken),
				)
			) {
				throw new Error("cancelled execution could not be durably cleared");
			}
			return {
				exitCode: null,
				signal: "SIGTERM",
				spawnError: null,
				supervisorPid: null,
			};
		}
		if (
			!authorizeActiveExecutionStart(
				options.db,
				ownerFence(options.ownerToken, executionToken),
			)
		) {
			throw new Error("execution START authorization was fenced");
		}
		logTelemetry((log) =>
			log.logExecutionStarted({ executionPid: prepared.pid, generation }),
		);
		const pass = await prepared.start(options.cancellation.signal);
		if (
			!clearActiveExecution(
				options.db,
				ownerFence(options.ownerToken, executionToken),
			)
		) {
			throw new Error("terminated execution could not be durably cleared");
		}
		registered = false;
		logTelemetry((log) =>
			log.logExecutionCleared({ executionPid: prepared.pid, generation }),
		);
		return pass;
	} catch (error) {
		try {
			await terminatePreparedExecution(prepared);
			if (registered) {
				const cleared = clearActiveExecution(
					options.db,
					ownerFence(options.ownerToken, executionToken),
				);
				if (!cleared) throw new Error("execution cleanup was fenced");
			}
		} catch (cleanupError) {
			prepared.disconnect();
			throw new AggregateError(
				[error, cleanupError],
				"execution failed and its boundary could not be proven safe; durable state is preserved",
			);
		}
		throw error;
	}
}

/** Recover any old execution, then run fresh fenced passes until idle. */
export async function runOwnedReconciliation(
	options: RunOwnedReconciliationOptions,
): Promise<OwnedReconciliationResult> {
	await recoverPriorExecution(options.db, options.ownerToken);
	if (options.cancellation.signal.aborted) {
		return { cancelled: true, exitCode: 2 };
	}

	let generation = options.initialGeneration;
	if (options.prepareRuntime !== undefined) {
		while (true) {
			const preparation = await options.prepareRuntime(
				options.cancellation.signal,
			);
			if (options.cancellation.signal.aborted) {
				return { cancelled: true, exitCode: 2 };
			}
			if (preparation.exitCode === 0) break;
			const finish = finishReconciliationPass(options.db, {
				generation,
				nowEpochMs: Date.now(),
				pid: process.pid,
				success: false,
				token: options.ownerToken,
			});
			if (finish.decision === "CONTINUE") {
				generation = finish.generation;
				continue;
			}
			return {
				cancelled: false,
				exitCode: preparation.exitCode ?? 1,
			};
		}
	}

	while (true) {
		logTelemetry((log) => log.logReconciliationPassStarted({ generation }));
		const pass = await runOnePass(options, generation);
		if (options.cancellation.signal.aborted) {
			return { cancelled: true, exitCode: 2 };
		}
		const success = passSucceeded(pass);
		const finish = finishReconciliationPass(options.db, {
			generation,
			nowEpochMs: Date.now(),
			pid: process.pid,
			success,
			token: options.ownerToken,
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
				log.logReconciliationIdle({ generation: finish.completedGeneration }),
			);
		}
		return {
			cancelled: false,
			exitCode: success ? 0 : (pass.exitCode ?? 1),
		};
	}
}
