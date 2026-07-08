import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { createEventSink } from "/Users/famillesendrison/Developper/Projects/telemetry-tools/event-sink/src/index.ts";

export function getAgentName(): string {
	if (process.env.ANTIGRAVITY_AGENT === "1") return "antigravity";
	if (process.env.PI_SESSION_ID !== undefined) return "pi";
	if (
		process.env.NODE_ENV === "test" ||
		process.env.PI_SKILL_STATS_MODE === "test"
	) {
		return "test";
	}
	throw new Error(
		"Error: Git-Commits-Push skill cannot determine the active agent from the environment.\n" +
			"Ensure you are running this skill from within the Antigravity IDE or the Pi Coding Agent.\n" +
			"Missing required environment variables (neither ANTIGRAVITY_AGENT nor PI_SESSION_ID is present).",
	);
}

const HOME = process.env.HOME || "/Users/famillesendrison";

let sink: ReturnType<typeof createEventSink> | null = null;
let lastSinkKey: string | undefined;

function getStatsDir(): string {
	return (
		process.env.PI_SKILL_STATS_DIR ??
		path.join(HOME, "neelopedia", "stats", getAgentName(), "git-commits-push")
	);
}

function getActiveSessionId(): string | undefined {
	if (process.env.ANTIGRAVITY_AGENT === "1") {
		return process.env.ANTIGRAVITY_TRAJECTORY_ID;
	}
	return process.env.PI_SESSION_ID;
}

function getSink(): ReturnType<typeof createEventSink> {
	const statsDir = getStatsDir();
	const agentName = getAgentName();
	const sessionId = getActiveSessionId();
	const sinkKey = `${statsDir}:${agentName}:${sessionId ?? ""}:${process.cwd()}`;
	if (!sink || sinkKey !== lastSinkKey) {
		lastSinkKey = sinkKey;
		sink = createEventSink({
			statsDir,
			agent: agentName,
			namespace: "git-commits-push",
			...(sessionId ? { sessionId } : {}),
			workspace: process.cwd(),
		});
	}
	return sink;
}

let secretSink: ReturnType<typeof createEventSink> | null = null;
let lastStatsDir: string | undefined;

function getSecretSink(): ReturnType<typeof createEventSink> {
	const currentStatsDir = process.env.SECRET_SCANNER_STATS_DIR;
	if (!secretSink || currentStatsDir !== lastStatsDir) {
		lastStatsDir = currentStatsDir;
		let statsDir = currentStatsDir;
		const agentName = getAgentName();
		if (!statsDir) {
			if (process.env.PI_SKILL_STATS_DIR) {
				statsDir = path.join(
					process.env.PI_SKILL_STATS_DIR,
					"..",
					"secret-scanner",
				);
			} else {
				statsDir = path.join(
					os.homedir(),
					"neelopedia",
					"stats",
					agentName,
					"secret-scanner",
				);
			}
		}
		secretSink = createEventSink({
			statsDir,
			agent: agentName,
			namespace: "secret-scanner",
		});
	}
	return secretSink;
}

function numberEnv(key: string): number | undefined {
	const value = process.env[key];
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function getOrderTelemetryContext(): Record<string, unknown> {
	const orderId = process.env.GCP_ORDER_ID;
	const orderOriginSessionId = process.env.GCP_ORDER_ORIGIN_SESSION_ID;
	const orderOriginAgent = process.env.GCP_ORDER_ORIGIN_AGENT;
	const orderCallerName = process.env.GCP_ORDER_CALLER_NAME;
	const orderQueuedAtEpochMs = numberEnv("GCP_ORDER_QUEUED_AT_EPOCH_MS");
	const orderTriggeredByRunId = process.env.GCP_ORDER_TRIGGERED_BY_RUN_ID;
	const executorSessionId = getActiveSessionId();
	const isQueuedOrder = process.env.GCP_ORDER_IS_QUEUED === "1";

	return {
		...(orderId ? { orderId } : {}),
		...(orderOriginSessionId ? { orderOriginSessionId } : {}),
		...(orderOriginAgent ? { orderOriginAgent } : {}),
		...(orderCallerName ? { orderCallerName } : {}),
		...(orderQueuedAtEpochMs ? { orderQueuedAtEpochMs } : {}),
		...(orderTriggeredByRunId ? { orderTriggeredByRunId } : {}),
		...(executorSessionId ? { executorSessionId } : {}),
		isQueuedOrder,
	};
}

function appendEvent(
	eventType: string,
	details: Record<string, unknown>,
	timestamp?: string,
): void {
	if (process.env.PI_SKILL_STATS_MODE === "test") return;

	getSink().append(
		eventType,
		{ ...getOrderTelemetryContext(), ...details, cycleId: crypto.randomUUID() },
		{
			...(timestamp ? { timestamp } : {}),
		},
	);
}

export interface SkillStatsLog {
	logOrderStarted(params: {
		orderId: string;
		runId: string;
		callerName: string;
		originAgent: string;
		isQueuedOrder: boolean;
		originSessionId?: string;
		queuedAtEpochMs?: number;
		triggeredByRunId?: string;
	}): void;

	logOrderQueued(params: {
		orderId: string;
		requestedRunId: string;
		originAgent: string;
		callerName: string;
		queuedAtEpochMs: number;
		position: number;
		blockedByRunId: string;
		blockedByCallerName: string;
		originSessionId?: string;
	}): void;

	logOrderDequeued(params: {
		orderId: string;
		requestedRunId: string;
		originAgent: string;
		callerName: string;
		queuedAtEpochMs: number;
		triggeredByRunId: string;
		remainingQueuedOrders: number;
		originSessionId?: string;
	}): void;

	logOrderFinished(params: {
		runId: string;
		outcome: string;
		successCount: number;
		failCount: number;
		totalRepos: number;
		totalRetries: number;
		error?: string;
	}): void;

	logQueueEmpty(params: { runId: string }): void;

	logRunStart(params: {
		runId: string;
		parentModel: string;
		skillModel: string;
		skillProvider: string;
		reposCount: number;
		thinking: boolean;
	}): void;

	logRunEnd(params: {
		runId: string;
		durationMs: number;
		successCount: number;
		failCount: number;
		totalRepos: number;
		totalRetries: number;
		loopCount: number;
		error?: string;
	}): void;

	logPhaseStart(params: {
		runId: string;
		phase: string;
		attemptCount: number;
	}): void;

	logPhaseEnd(params: {
		runId: string;
		phase: string;
		durationMs: number;
		resultKind: string;
	}): void;

	logDelegation(params: {
		runId: string;
		repoId: string;
		repository: string;
		isRetry: boolean;
		retryKind: string | null;
		attempt: number;
		model: string;
		thinking: boolean;
		diffHash: string;
		diffSizeBytes: number | null;
		previousDiffHash: string | null;
		diffChanged: boolean | null;
		pendingFilesCount: number | null;
		feedbackHistoryItems: number;
		retryReason?: string;
	}): void;

	logRetry(params: {
		runId: string;
		repoId: string;
		kind: string;
		attempt: number;
		maxAttempts: number;
		diffHash: string;
		model: string;
		thinking: boolean;
	}): void;

	logLoopDetected(params: {
		runId: string;
		repoId: string;
		kind: string;
		planHash: string;
	}): void;

	logRepoOutcome(params: {
		runId: string;
		repoId: string;
		repository: string;
		status: string;
		error?: string;
		attempts: Record<string, number>;
		totalRetries: number;
		loopDetected?: { kind: string; planHash: string };
		committedCount: number;
	}): void;

	logSecretBlock(params: {
		repoId: string;
		repoPath: string;
		matchCount: number;
		details: string;
	}): void;

	logSecretPass(params: { repoId: string; repoPath: string }): void;
}

export function createSkillStatsLog(): SkillStatsLog {
	return {
		logOrderStarted(params) {
			appendEvent("order_started", {
				orderId: params.orderId,
				runId: params.runId,
				callerName: params.callerName,
				originAgent: params.originAgent,
				isQueuedOrder: params.isQueuedOrder,
				originSessionId: params.originSessionId,
				queuedAtEpochMs: params.queuedAtEpochMs,
				triggeredByRunId: params.triggeredByRunId,
			});
		},

		logOrderQueued(params) {
			appendEvent("order_queued", {
				orderId: params.orderId,
				requestedRunId: params.requestedRunId,
				originAgent: params.originAgent,
				callerName: params.callerName,
				originSessionId: params.originSessionId,
				queuedAtEpochMs: params.queuedAtEpochMs,
				position: params.position,
				blockedByRunId: params.blockedByRunId,
				blockedByCallerName: params.blockedByCallerName,
			});
		},

		logOrderDequeued(params) {
			appendEvent("order_dequeued", {
				orderId: params.orderId,
				requestedRunId: params.requestedRunId,
				originAgent: params.originAgent,
				callerName: params.callerName,
				originSessionId: params.originSessionId,
				queuedAtEpochMs: params.queuedAtEpochMs,
				triggeredByRunId: params.triggeredByRunId,
				remainingQueuedOrders: params.remainingQueuedOrders,
			});
		},

		logOrderFinished(params) {
			appendEvent("order_finished", {
				runId: params.runId,
				outcome: params.outcome,
				successCount: params.successCount,
				failCount: params.failCount,
				totalRepos: params.totalRepos,
				totalRetries: params.totalRetries,
				error: params.error,
			});
		},

		logQueueEmpty(params) {
			appendEvent("queue_empty", {
				runId: params.runId,
			});
		},

		logRunStart(params) {
			appendEvent("run_start", {
				runId: params.runId,
				parentModel: params.parentModel,
				skillModel: params.skillModel,
				skillProvider: params.skillProvider,
				reposCount: params.reposCount,
				thinking: params.thinking,
			});
		},

		logRunEnd(params) {
			appendEvent("run_end", {
				runId: params.runId,
				durationMs: params.durationMs,
				successCount: params.successCount,
				failCount: params.failCount,
				totalRepos: params.totalRepos,
				totalRetries: params.totalRetries,
				loopCount: params.loopCount,
				error: params.error,
			});
		},

		logPhaseStart(params) {
			appendEvent("phase_start", {
				runId: params.runId,
				phase: params.phase,
				attemptCount: params.attemptCount,
			});
		},

		logPhaseEnd(params) {
			appendEvent("phase_end", {
				runId: params.runId,
				phase: params.phase,
				durationMs: params.durationMs,
				resultKind: params.resultKind,
			});
		},

		logDelegation(params) {
			appendEvent("delegation", {
				runId: params.runId,
				repoId: params.repoId,
				repository: params.repository,
				isRetry: params.isRetry,
				retryKind: params.retryKind,
				attempt: params.attempt,
				model: params.model,
				thinking: params.thinking,
				diffHash: params.diffHash,
				diffSizeBytes: params.diffSizeBytes,
				previousDiffHash: params.previousDiffHash,
				diffChanged: params.diffChanged,
				pendingFilesCount: params.pendingFilesCount,
				feedbackHistoryItems: params.feedbackHistoryItems,
				retryReason: params.retryReason,
			});
		},

		logRetry(params) {
			appendEvent("retry", {
				runId: params.runId,
				repoId: params.repoId,
				kind: params.kind,
				attempt: params.attempt,
				maxAttempts: params.maxAttempts,
				diffHash: params.diffHash,
				model: params.model,
				thinking: params.thinking,
			});
		},

		logLoopDetected(params) {
			appendEvent("loop_detected", {
				runId: params.runId,
				repoId: params.repoId,
				kind: params.kind,
				planHash: params.planHash,
			});
		},

		logRepoOutcome(params) {
			appendEvent("repo_outcome", {
				runId: params.runId,
				repoId: params.repoId,
				repository: params.repository,
				status: params.status,
				error: params.error,
				attempts: params.attempts,
				totalRetries: params.totalRetries,
				loopDetected: params.loopDetected,
				committedCount: params.committedCount,
			});
		},

		logSecretBlock(params) {
			if (process.env.PI_SKILL_STATS_MODE === "test") return;
			if (
				process.env.NODE_ENV === "test" &&
				!process.env.SECRET_SCANNER_STATS_DIR &&
				!process.env.PI_SKILL_STATS_DIR
			) {
				return;
			}
			const findings = params.details
				.split(", ")
				.filter(Boolean)
				.map((d) => {
					const match = d.match(/^(.*) at line (\d+)$/);
					if (match) {
						return {
							name: match[1] || "",
							line: "",
							lineNumber: parseInt(match[2] || "0", 10),
						};
					}
					return { name: d, line: "", lineNumber: 0 };
				});

			getSecretSink().append(
				"block",
				{
					findingsCount: params.matchCount,
					findings,
					_source: "git-commits-push-skill",
				},
				{
					sessionId: `skill-${params.repoId}`,
					workspace: params.repoPath,
				},
			);
		},

		logSecretPass(params) {
			if (process.env.PI_SKILL_STATS_MODE === "test") return;
			if (
				process.env.NODE_ENV === "test" &&
				!process.env.SECRET_SCANNER_STATS_DIR &&
				!process.env.PI_SKILL_STATS_DIR
			) {
				return;
			}
			getSecretSink().append(
				"passed",
				{
					findingsCount: 0,
					findings: [],
					_source: "git-commits-push-skill",
				},
				{
					sessionId: `skill-${params.repoId}`,
					workspace: params.repoPath,
				},
			);
		},
	};
}
