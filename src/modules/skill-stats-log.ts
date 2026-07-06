/**
 * Skill-stats logging module for git-commits-push.
 *
 * Logs run-level events to ~/neelopedia/stats/pi/git-commits-push/events.jsonl.
 * Uses event-sink for atomic writes and a normalized envelope.
 *
 * This module runs inside the skill process (bun), not in the Pi agent.
 */
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { createEventSink } from "/Users/famillesendrison/Developper/Projects/telemetry-tools/event-sink/src/index.ts";

// ── Paths ────────────────────────────────────────────────────────────────────

export function getAgentName(): string {
	if (process.env.ANTIGRAVITY_AGENT === "1") return "antigravity";
	if (process.env.PI_SESSION_ID !== undefined) return "pi";
	if (process.env.NODE_ENV === "test" || process.env.PI_SKILL_STATS_MODE === "test") {
		return "test";
	}
	throw new Error(
		"Error: Git-Commits-Push skill cannot determine the active agent from the environment.\n" +
		"Ensure you are running this skill from within the Antigravity IDE or the Pi Coding Agent.\n" +
		"Missing required environment variables (neither ANTIGRAVITY_AGENT nor PI_SESSION_ID is present)."
	);
}

const HOME = process.env.HOME || "/Users/famillesendrison";
const isAntigravity = process.env.ANTIGRAVITY_AGENT === "1";
const STATS_DIR =
	process.env.PI_SKILL_STATS_DIR ??
	path.join(HOME, "neelopedia", "stats", getAgentName(), "git-commits-push");

// ── Sink factory ─────────────────────────────────────────────────────────────

let sink: ReturnType<typeof createEventSink> | null = null;

function getSink(): ReturnType<typeof createEventSink> {
	if (!sink) {
		const agentName = getAgentName();
		const sessionId = isAntigravity ? process.env.ANTIGRAVITY_TRAJECTORY_ID : process.env.PI_SESSION_ID;
		sink = createEventSink({
			statsDir: STATS_DIR,
			agent: agentName,
			namespace: "git-commits-push",
			...(sessionId ? { sessionId } : {}),
			workspace: process.cwd(),
		});
	}
	return sink;
}

let secretSink: ReturnType<typeof createEventSink> | null = null;
let lastStatsDir: string | undefined = undefined;

function getSecretSink(): ReturnType<typeof createEventSink> {
	const currentStatsDir = process.env.SECRET_SCANNER_STATS_DIR;
	if (!secretSink || currentStatsDir !== lastStatsDir) {
		lastStatsDir = currentStatsDir;
		let statsDir = currentStatsDir;
		const agentName = getAgentName();
		if (!statsDir) {
			if (process.env.PI_SKILL_STATS_DIR) {
				statsDir = path.join(process.env.PI_SKILL_STATS_DIR, "..", "secret-scanner");
			} else {
				statsDir = path.join(os.homedir(), "neelopedia", "stats", agentName, "secret-scanner");
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

// ── Event writer ─────────────────────────────────────────────────────────────

function appendEvent(
	eventType: string,
	details: Record<string, unknown>,
	timestamp?: string,
): void {
	if (process.env.PI_SKILL_STATS_MODE === "test") return;

	getSink().append(
		eventType,
		{ ...details, cycleId: crypto.randomUUID() },
		{
			...(timestamp ? { timestamp } : {}),
		},
	);
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface SkillStatsLog {
	/** Run started */
	logRunStart(params: {
		runId: string;
		parentModel: string;
		skillModel: string;
		skillProvider: string;
		reposCount: number;
		thinking: boolean;
	}): void;

	/** Run ended (success or fail) */
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

	/** Phase started */
	logPhaseStart(params: {
		runId: string;
		phase: string;
		attemptCount: number;
	}): void;

	/** Phase ended */
	logPhaseEnd(params: {
		runId: string;
		phase: string;
		durationMs: number;
		resultKind: string;
	}): void;

	/** Each LLM delegation (initial + retries) — unified event replacing logRetry */
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

	/** @deprecated — logDelegation now covers this */
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

	/** Loop detected for a repo */
	logLoopDetected(params: {
		runId: string;
		repoId: string;
		kind: string;
		planHash: string;
	}): void;

	/** Final outcome for a repo */
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

	/** Secret scanner validation block */
	logSecretBlock(params: {
		repoId: string;
		repoPath: string;
		matchCount: number;
		details: string;
	}): void;

	/** Secret scanner validation success */
	logSecretPass(params: {
		repoId: string;
		repoPath: string;
	}): void;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createSkillStatsLog(): SkillStatsLog {
	// Sink is created lazily on first append (not here)
	return {
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
						return { name: match[1] || "", line: "", lineNumber: parseInt(match[2] || "0", 10) };
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
