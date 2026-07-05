/**
 * Skill-stats logging module for git-commits-push.
 *
 * Logs run-level events to ~/neelopedia/stats/pi/git-commits-push/events.jsonl.
 * Follows the same atomic-append pattern as Pi extensions.
 * This module runs inside the skill process (bun), not in the Pi agent.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Paths ────────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || "/Users/famillesendrison";
const STATS_DIR =
	process.env.PI_SKILL_STATS_DIR ??
	path.join(HOME, "neelopedia", "stats", "pi", "git-commits-push");
const FILE_PATH = path.join(STATS_DIR, "events.jsonl");

// ── Atomic append ────────────────────────────────────────────────────────────

function atomicAppend(filePath: string, newContent: string): void {
	try {
		let existingContent = "";
		if (fs.existsSync(filePath)) {
			existingContent = fs.readFileSync(filePath, "utf-8");
		}
		const combinedContent = existingContent + newContent;
		const tmpPath = `${filePath}.tmp.${process.pid}`;
		fs.writeFileSync(tmpPath, combinedContent);
		fs.renameSync(tmpPath, filePath);
	} catch (err) {
		process.stderr.write(
			`[git-commits-push:stats-log] Error writing stats: ${err}\n`,
		);
	}
}

// ── Event writer ─────────────────────────────────────────────────────────────

function appendEvent(
	eventType: string,
	details: Record<string, unknown>,
	timestamp?: string,
): void {
	if (process.env.PI_SKILL_STATS_MODE === "test") return;

	const event = {
		timestamp: timestamp || new Date().toISOString(),
		eventId: crypto.randomUUID(),
		extension: "git-commits-push",
		eventType,
		agent: "pi",
		workspace: process.cwd(),
		sessionId: process.env.PI_SESSION_ID || "unknown",
		cycleId: crypto.randomUUID(),
		details,
	};
	atomicAppend(FILE_PATH, `${JSON.stringify(event)}\n`);
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
		model: string;
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

	/** Retry queued for a repo */
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
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createSkillStatsLog(): SkillStatsLog {
	fs.mkdirSync(STATS_DIR, { recursive: true });

	return {
		logRunStart(params) {
			appendEvent("run_start", {
				runId: params.runId,
				parentModel: params.parentModel,
				skillModel: params.skillModel,
				skillProvider: params.skillProvider,
				reposCount: params.reposCount,
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
				model: params.model,
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
	};
}
