import { sanitizeSensitiveDiagnostic } from "../core/sensitive-diagnostic-sanitizer.ts";
import type { SkillStatsLog } from "./stats-events.ts";
import {
	appendEvent,
	getSecretSink,
	parseSecretDetails,
} from "./stats-sinks.ts";

export type { SkillStatsLog } from "./stats-events.ts";
export { getActiveSessionId, getAgentName } from "./stats-sinks.ts";

function secretTelemetryIsDisabled(): boolean {
	return (
		process.env.PI_SKILL_STATS_MODE === "test" ||
		(process.env.NODE_ENV === "test" &&
			!process.env.SECRET_SCANNER_STATS_DIR &&
			!process.env.PI_SKILL_STATS_DIR)
	);
}

function appendSecretFindingEvent(
	eventType: "block" | "warning",
	params: {
		repoId: string;
		repoPath: string;
		matchCount: number;
		details: string;
	},
): void {
	if (secretTelemetryIsDisabled()) return;
	getSecretSink().append(
		eventType,
		{
			findingsCount: params.matchCount,
			findings: parseSecretDetails(params.details),
			_source: "git-commits-push-skill",
		},
		{
			sessionId: `skill-${params.repoId}`,
			workspace: params.repoPath,
		},
	);
}

export function createSkillStatsLog(): SkillStatsLog {
	return {
		logRequestStarted(params) {
			appendEvent("order_started", {
				orderId: params.requestId,
				runId: params.runId,
				callerName: params.callerName,
				originAgent: params.originAgent,
				originSessionId: params.originSessionId,
			});
		},
		logRequestFinished(params) {
			appendEvent("order_finished", {
				runId: params.runId,
				outcome: params.outcome,
				successCount: params.successCount,
				failCount: params.failCount,
				totalRepos: params.totalRepos,
				totalRetries: params.totalRetries,
				error: params.error
					? sanitizeSensitiveDiagnostic(params.error)
					: params.error,
			});
		},
		logReconciliationRequested(params) {
			appendEvent("reconciliation_requested", {
				generation: params.generation,
				outcome: params.outcome,
				callerName: params.callerName,
				originAgent: params.originAgent,
				originSessionId: params.originSessionId,
				recovered: params.recovered,
			});
		},
		logReconciliationCoalesced(params) {
			appendEvent("reconciliation_coalesced", {
				generation: params.generation,
				ownerPid: params.ownerPid,
				ownerCallerName: params.ownerCallerName,
			});
		},
		logReconciliationPassStarted(params) {
			appendEvent("reconciliation_pass_started", {
				generation: params.generation,
			});
		},
		logReconciliationPassFinished(params) {
			appendEvent("reconciliation_pass_finished", {
				generation: params.generation,
				exitCode: params.exitCode,
				success: params.success,
				decision: params.decision,
			});
		},
		logReconciliationRecovered(params) {
			appendEvent("reconciliation_recovered", {
				generation: params.generation,
				previousOwnerPid: params.previousOwnerPid,
			});
		},
		logReconciliationIdle(params) {
			appendEvent("reconciliation_idle", { generation: params.generation });
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
				error: params.error
					? sanitizeSensitiveDiagnostic(params.error)
					: params.error,
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
				error: params.error
					? sanitizeSensitiveDiagnostic(params.error)
					: params.error,
				attempts: params.attempts,
				totalRetries: params.totalRetries,
				loopDetected: params.loopDetected,
				committedCount: params.committedCount,
			});
		},
		logSecretBlock(params) {
			appendSecretFindingEvent("block", params);
		},
		logSecretWarning(params) {
			appendSecretFindingEvent("warning", params);
		},
		logSecretPass(params) {
			if (secretTelemetryIsDisabled()) return;
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
