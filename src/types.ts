/**
 * src/types.ts — Type contracts shared between production code and tests.
 * This file must reflect the schemas defined in NIB-S §3 (Data Structures).
 *
 * STATUS: STUB — production implementation pending (RED phase).
 */

export interface Settings {
	searchPaths: string[];
	provider: string;
	model: string;
	temperature: number;
	systemPromptPath: string;
	autoPush: boolean;
	skipTests: boolean;
	fallbackProvider?: string;
	fallbackModel?: string;
	thinking?: boolean;
}

export interface RepositoryInfo {
	id: string;
	path: string;
}

export interface CommitMessage {
	type: string;
	scope?: string | undefined;
	description: string;
	body?: string | undefined;
	isBreaking: boolean;
}

/**
 * A single commit plan: one commit message + the list of files to stage for it.
 * Multiple CommitPlans per repo enable file-level commit splitting.
 */
export interface CommitPlan {
	commit: CommitMessage;
	files: string[]; // relative paths from the repo root
}

// ── FeedbackError ────────────────────────────────────────────────────────

/**
 * Unified error shape in feedback. Replaces the old validation_errors string[]
 * with a structured discriminated union by kind.
 * Plan ref: Phase 2 — Extended types, FeedbackError
 */
export interface FeedbackError {
	kind: "validation" | "structural" | "race" | "git" | "network";
	message: string;
	resolution_hint?: string;
	files?: string[];
}

// ── CommittedSha ─────────────────────────────────────────────────────────

/**
 * One entry per actually-landed commit.
 * SHA stored full-length; sliced to 7 chars at display time only.
 * Plan ref: Phase 2 — Decision 3
 */
export interface CommittedSha {
	sha: string;
	files: string[];
}

// ── Feedback ─────────────────────────────────────────────────────────────

/**
 * Feedback sent to the LLM on retry. Replaces the old shape
 * `{ previous_commit: string; validation_errors: string[] }`.
 * Plan ref: Phase 2 — Feedback interface
 */
export interface Feedback {
	/** Rolling history across all attempts */
	previous_commit: string;
	/** Structured error list (one per failed plan) */
	errors: FeedbackError[];
	/** Present only for PartialCommitError — SHAs that already landed */
	committed_shas?: CommittedSha[];
	/** Present only for PartialCommitError — files planned but not yet committed */
	pending_files?: string[];
	/** Round 8 (Decision 16): optional context hints for escalation */
	recommended_action?:
		| "git-reset-and-recommit"
		| "manual-fix-needed"
		| "unknown";
	/** Set when a consecutive identical plan is detected */
	loop_detected?: { kind: FeedbackError["kind"]; planHash: string };
}

// ── AttemptsByKind ───────────────────────────────────────────────────────

/**
 * Per-kind attempt counters, scoped to a single diffHash.
 * New diffHash → fresh counters (Decision 7).
 * Plan ref: Phase 2 — AttemptsByKind
 */
export type AttemptsByKind = Partial<Record<FeedbackError["kind"], number>>;

/**
 * Payload embedded as JSON string inside an AgentBatchDelegationRequest job's `prompt` field.
 * See: NIB-S §3 > CommitJobPayload, DC-TURNLOCK §4.
 *
 * R41 fix: `diff` semantic is overloaded by design.
 *   - First attempt: full staged diff (populated by diff-capture phase).
 *   - Retries: reconstructed remaining-work diff (populated by queueRetry).
 * The bridge always renders payload.diff inside <remaining-diff> tags.
 */
export interface CommitJobPayload {
	repository: string;
	diff: string;
	diffHash: string;
	provider: string;
	model: string;
	temperature: number;
	systemPrompt: string;
	/**
	 * Optional feedback from a previous failed attempt.
	 * Replaced validation_errors string[] with structured Feedback
	 * (Phase 2 — Feedback interface).
	 */
	feedback?: Feedback;
	/** Enable thinking/reasoning for supported providers (e.g. DeepSeek) */
	thinking?: boolean;
}

/** Written by the Pi wrapper to each job's resultPath on success */
export interface CommitJobResultSuccess {
	success: true;
	id: string;
	commits: CommitPlan[];
}

/** Written by the Pi wrapper to each job's resultPath on failure */
export interface CommitJobResultError {
	success: false;
	id: string;
	error: string;
}

export type CommitJobResult = CommitJobResultSuccess | CommitJobResultError;

export interface RepoState {
	repository: string;
	status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";
	diffHash?: string;
	/**
	 * Plural commits. Legacy singular `commit?: CommitMessage` is silently
	 * dropped by the migration shim (never written by any code path).
	 */
	commits?: CommitPlan[];
	error?: string;
	/**
	 * CHANGED (Phase 2): per-kind counter replacing legacy `number`.
	 * Migration shim converts legacy `attempts: number` to `{}` (zeroed).
	 */
	attempts?: AttemptsByKind;
	/** NEW: cumulative across retries (Decision 3) */
	committedShas?: CommittedSha[];
	/** NEW: HEAD SHA before any commit in this invocation */
	originalHead?: string;
	/** NEW: rolling previous_commit history for the LLM (capped, Decision 11) */
	feedbackHistory?: string[];
	/** NEW: loop detection — hash of the last plan structure (Decision 12) */
	lastPlanHash?: string;
	/**
	 * R62 fix: dedicated field for loop-detected outcome.
	 * Set by the orchestrator when classifyError or queueRetry detects a loop.
	 * The reporter reads it directly (no regex extraction from error string).
	 */
	loopDetected?: {
		kind: FeedbackError["kind"];
		planHash: string;
	};
	/** NEW: true when the fallback model has been tried for this repo */
	fallbackAttempted?: boolean;
}
// ── RepoReport (Phase 8) ───────────────────────────────────────────────

/**
 * Structured execution report for a single repository.
 * Built by buildReport() from RepoState, rendered by generateReport().
 * Plan ref: Phase 8 — Reporter contract (R39, R62)
 */
export interface RepoReport {
	repository: string;
	status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";
	error?: string;
	committedShas: CommittedSha[];
	attempts: Partial<Record<FeedbackError["kind"], number>>;
	totalRetries: number;
	loopDetected?: { kind: FeedbackError["kind"]; planHash: string };
}

export interface GlobalState {
	repos: Record<string, RepoState>;
}
