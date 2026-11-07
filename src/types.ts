/** Shared runtime and durable-state contracts; parsed through config/state-schema.ts. */

import type {
	CreationAnchor,
	ExplicitCreatePushSnapshot,
	ExplicitCreateTargetSnapshot,
} from "./modules/git/creation-types.ts";

export type ExplicitPublicationTargetSnapshot =
	| ExplicitPushTargetSnapshot
	| ExplicitCreateTargetSnapshot;

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
	/** Agent name for nested credential lookup in agent-credentials.json */
	agent?: string;
	/**
	 * Maximum diff size (chars) before truncation.
	 * When exceeded, the diff is truncated and replaced with `git diff --stat`
	 * to stay within LLM context window limits. Defaults to 3_000_000 (~750K tokens).
	 */
	maxDiffChars?: number;
}

/**
 * Durable invocation universe for one Turnlock run.
 *
 * `global` is legacy persisted-only state: it may survive in historical
 * Turnlock runs and legacy reconciliation recovery, but no fresh public
 * invocation produces it. `worktree` means the caller asked to process exactly
 * the canonical Git worktree containing the original invocation directory, so
 * no discovery may widen beyond it. `targeted` means the caller named exactly
 * one canonical worktree plus explicit remote/ref publication intent, and no
 * discovery may widen beyond it.
 */
export type InvocationScope =
	| {
			readonly kind: "global";
	  }
	| {
			readonly kind: "worktree";
			readonly repository: string;
	  }
	| {
			readonly kind: "targeted";
			readonly repository: string;
			readonly pushRemote: string;
			readonly pushRef: string;
	  }
	| ({
			readonly kind: "targeted-create";
			readonly repository: string;
			readonly pushRemote: string;
			readonly pushRef: string;
	  } & CreationAnchor);

export type RepositoryOperation = "commit-and-push" | "push-only";

export const REMOTE_TRACKING_REF_SYNCHRONIZATION_OUTCOMES = [
	"synchronized",
	"already-current",
	"not-applicable",
	"concurrent-update-preserved",
	"failed",
] as const;

export type RemoteTrackingRefSynchronization =
	(typeof REMOTE_TRACKING_REF_SYNCHRONIZATION_OUTCOMES)[number];

/**
 * Explicit publication authority named by `InvocationScope.targeted`.
 *
 * It carries a destination only: no source branch, no upstream ref, no
 * local-tracking projection, and no upstream-establishment intent.
 */
export interface ExplicitPushDestination {
	readonly remote: string;
	readonly destinationRef: string;
}

/**
 * Observation of the explicit destination frozen before any commit or push
 * effect exists for this invocation.
 *
 * `InvocationScope` is the caller's durable intention; this snapshot is the
 * remotely observed baseline that later publication must still match. The raw
 * push URL is never stored, only its fingerprint.
 */
export interface ExplicitPushTargetSnapshot {
	readonly remote: string;
	readonly destinationRef: string;
	readonly destinationBaselineSha: string;
	readonly pushUrlFingerprint: string;
}

/** Publication snapshot for a branch whose upstream identity is significant. */
export interface TrackedPushSnapshot {
	readonly kind: "tracked";
	readonly sourceBranch: string;
	readonly validatedHeadSha: string;
	readonly upstreamRef: string;
	readonly remote: string;
	readonly destinationRef: string;
	readonly destinationBaselineSha: string;
	readonly outgoingShas: string[];
	/** SHA-256 of the single effective push URL; the URL itself is never persisted. */
	readonly pushUrlFingerprint: string;
}

/**
 * Publication snapshot for an explicit destination. It deliberately has no
 * `sourceBranch` and no `upstreamRef`: a detached-HEAD publication has neither.
 */
export interface ExplicitPushSnapshot {
	readonly kind: "explicit";
	readonly validatedHeadSha: string;
	readonly remote: string;
	readonly destinationRef: string;
	readonly destinationBaselineSha: string;
	readonly outgoingShas: string[];
	/** SHA-256 of the single effective push URL; the URL itself is never persisted. */
	readonly pushUrlFingerprint: string;
}

export type PushSnapshot =
	| TrackedPushSnapshot
	| ExplicitPushSnapshot
	| ExplicitCreatePushSnapshot;

export interface RepositoryInfo {
	id: string;
	path: string;
	operation?: RepositoryOperation;
	pushSnapshot?: PushSnapshot;
	explicitPushTargetSnapshot?: ExplicitPublicationTargetSnapshot;
}

export interface CommitMessage {
	type: string;
	scope?: string | null | undefined;
	description: string;
	body?: string | null | undefined;
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
	kind: "validation" | "structural" | "race" | "git" | "network" | "provider";
	message: string;
	resolution_hint?: string | undefined;
	files?: string[] | undefined;
	planIndex?: number | undefined;
	rule?: "commit-message" | "subject-max-length" | undefined;
	rejectedSubject?: string | undefined;
	actualLength?: number | undefined;
	maximumLength?: number | undefined;
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

/** Pre-commit HEAD, or `null` when the branch was proven unborn. */
export type OriginalHead = string | null;

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
	committed_shas?: CommittedSha[] | undefined;
	/** Present only for PartialCommitError — files planned but not yet committed */
	pending_files?: string[] | undefined;
	/** Round 8 (Decision 16): optional context hints for escalation */
	recommended_action?:
		| "git-reset-and-recommit"
		| "manual-fix-needed"
		| "unknown"
		| undefined;
	/** Set when a consecutive identical plan is detected */
	loop_detected?: { kind: FeedbackError["kind"]; planHash: string } | undefined;
}

// ── AttemptsByKind ───────────────────────────────────────────────────────

/**
 * Per-kind attempt counters, scoped to a single diffHash.
 * New diffHash → fresh counters (Decision 7).
 * Plan ref: Phase 2 — AttemptsByKind
 */
export type AttemptsByKind = Partial<Record<FeedbackError["kind"], number>>;

/**
 * Payload embedded as JSON string inside a BatchDelegationRequest job's `prompt` field.
 * See: NIB-S §3 > CommitJobPayload, DC-TURNLOCK §4.
 *
 * R41 fix: `diff` semantic is overloaded by design.
 *   - First attempt: full staged diff (populated by diff-capture phase).
 *   - Retries: reconstructed remaining-work diff (populated by queueRetry).
 * The bridge always renders payload.diff inside <remaining-diff> tags.
 */
interface CommitJobPayloadBase {
	repository: string;
	diffHash: string;
	provider: string;
	model: string;
	temperature: number;
	systemPrompt: string;
	/** Enable thinking/reasoning for supported providers (e.g. DeepSeek) */
	thinking?: boolean | undefined;
	/** Agent name for nested credential lookup in agent-credentials.json */
	agent?: string | undefined;
}

export interface CommitPlanningPayload extends CommitJobPayloadBase {
	mode?: "plan" | undefined;
	diff: string;
	/** Structured feedback for non-validation retries. */
	feedback?: Feedback | undefined;
}

export interface CommitMessageRepairPayload extends CommitJobPayloadBase {
	mode: "repair-commit-messages";
	rejectedPlans: CommitPlan[];
	validationErrors: FeedbackError[];
}

export type CommitJobPayload =
	| CommitPlanningPayload
	| CommitMessageRepairPayload;

/** Internal no-effect Turnlock yields persist publication evidence without inference. */
export type PublicationCheckpointPayload = { repository: string } & (
	| { mode: "checkpoint-push-only" }
	| { mode: "checkpoint-creation-outcome" }
	| { mode: "checkpoint-commit-outcome" }
);
export type PushOnlyCheckpointPayload = PublicationCheckpointPayload & {
	mode: "checkpoint-push-only";
};

export type BridgeJobPayload = CommitJobPayload | PublicationCheckpointPayload;

/** Written by the Turnlock-to-LLM bridge to each job's resultPath on success */
export interface CommitJobResultSuccess {
	success: true;
	id: string;
	commits: CommitPlan[];
}

/** Written by the Turnlock-to-LLM bridge to each job's resultPath on failure */
export interface CommitJobResultError {
	/** Preserve ownership when a provider fails during message-only repair. */
	rejectedPlans?: CommitPlan[];
	providerFailureKind?: import("./modules/llm/provider-failure.ts").ProviderFailureKind;
	success: false;
	id: string;
	error: string;
}

export type CommitJobResult = CommitJobResultSuccess | CommitJobResultError;

/** Immutable Git authority captured before inference and retained across every retry. */
export interface ValidatedSourceWitness {
	readonly repository: string;
	readonly gitDirectory: string;
	readonly baseHeadSha: OriginalHead;
	readonly expectedTreeSha: string;
	readonly expectedChangedPaths: readonly string[];
	readonly publicationRequired: boolean;
}

export interface CommitCompletionEvidence {
	readonly finalHeadSha: string;
	readonly finalTreeSha: string;
}

export interface RepoState {
	validatedSource?: ValidatedSourceWitness | undefined;
	commitCompletion?: CommitCompletionEvidence | undefined;
	repository: string;
	status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";
	operation?: RepositoryOperation | undefined;
	pushSnapshot?: PushSnapshot | undefined;
	explicitPushTargetSnapshot?: ExplicitPublicationTargetSnapshot | undefined;
	/** Final validated identity/history; required for successful dirty creation. */
	creationPublicationSnapshot?: ExplicitCreatePushSnapshot | undefined;
	pushedShas?: string[] | undefined;
	/** Exact source SHA observed at the frozen remote after publication. */
	publishedSha?: string | undefined;
	/** Outcome of the separate local remote-tracking projection step. */
	remoteTrackingRefSynchronization?:
		| RemoteTrackingRefSynchronization
		| undefined;
	diffHash?: string | undefined;
	/**
	 * Plural commits. Legacy singular `commit?: CommitMessage` is silently
	 * dropped by the migration shim (never written by any code path).
	 */
	commits?: CommitPlan[] | undefined;
	error?: string | undefined;
	/**
	 * CHANGED (Phase 2): per-kind counter replacing legacy `number`.
	 * Migration shim converts legacy `attempts: number` to `{}` (zeroed).
	 */
	attempts?: AttemptsByKind | undefined;
	/** NEW: cumulative across retries (Decision 3) */
	committedShas?: CommittedSha[] | undefined;
	/** NEW: HEAD SHA before any commit, or null for a proven unborn branch */
	originalHead?: OriginalHead | undefined;
	/** NEW: rolling previous_commit history for the LLM (capped, Decision 11) */
	feedbackHistory?: string[] | undefined;
	/** NEW: loop detection — hash of the last plan structure (Decision 12) */
	lastPlanHash?: string | undefined;
	/**
	 * R62 fix: dedicated field for loop-detected outcome.
	 * Set by the orchestrator when classifyError or queueRetry detects a loop.
	 * The reporter reads it directly (no regex extraction from error string).
	 */
	loopDetected?:
		| {
				kind: FeedbackError["kind"];
				planHash: string;
		  }
		| undefined;
	/** NEW: true when the fallback model has been tried for this repo */
	fallbackAttempted?: boolean | undefined;
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
	error?: string | undefined;
	committedShas: CommittedSha[];
	pushedShas: string[];
	publishedSha?: string | undefined;
	remoteTrackingRefSynchronization?:
		| RemoteTrackingRefSynchronization
		| undefined;
	attempts: Partial<Record<FeedbackError["kind"], number>>;
	totalRetries: number;
	loopDetected?: { kind: FeedbackError["kind"]; planHash: string } | undefined;
}

export interface GlobalState {
	readonly invocationScope: InvocationScope;
	repos: Record<string, RepoState>;
}
