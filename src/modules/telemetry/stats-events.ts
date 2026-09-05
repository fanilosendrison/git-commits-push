export interface SkillStatsLog {
	logRequestStarted(params: {
		requestId: string;
		runId: string;
		callerName: string;
		originAgent: string;
		originSessionId?: string;
	}): void;
	logRequestFinished(params: {
		runId: string;
		outcome: string;
		successCount: number;
		failCount: number;
		totalRepos: number;
		totalRetries: number;
		error?: string;
	}): void;
	logReconciliationRequested(params: {
		generation: number;
		outcome: "owner" | "coalesced";
		callerName: string;
		originAgent: string;
		originSessionId?: string;
		recovered?: boolean;
	}): void;
	logReconciliationCoalesced(params: {
		generation: number;
		ownerPid: number | null;
		ownerCallerName: string | null;
	}): void;
	logReconciliationPassStarted(params: { generation: number }): void;
	logReconciliationPassFinished(params: {
		generation: number;
		exitCode: number;
		success: boolean;
		decision: "CONTINUE" | "STOP_SUCCESS" | "STOP_FAILED";
	}): void;
	logReconciliationRecovered(params: {
		generation: number;
		previousOwnerPid: number | null;
	}): void;
	logReconciliationIdle(params: { generation: number }): void;
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
	logSecretWarning(params: {
		repoId: string;
		repoPath: string;
		matchCount: number;
		details: string;
	}): void;
	logSecretPass(params: { repoId: string; repoPath: string }): void;
}
