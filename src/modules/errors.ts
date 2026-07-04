/**
 * src/modules/errors.ts — Phase 1: Typed Error Hierarchy
 *
 * Defines the typed error classes used by the publisher and orchestrator.
 * Import direction: this module may import type-only from types.ts;
 * types.ts MUST NOT import from this module (acyclic dependency contract).
 */

import type { CommittedSha } from "../types.ts";

// ── CommitPlanError ──────────────────────────────────────────────────────────

export type CommitPlanErrorKind =
	| "duplicate-file"
	| "empty-plans"
	| "missing-file"
	| "nonexistent-file";

/**
 * Thrown by the publisher guard when a commit plan is structurally invalid.
 *
 * `context` carries mid-loop state (R59) so the orchestrator can merge
 * committed SHAs and pending files into repoState even when the error
 * is thrown AFTER some commits have already landed.
 */
export class CommitPlanError extends Error {
	override name = "CommitPlanError";

	constructor(
		message: string,
		public readonly kind: CommitPlanErrorKind,
		public readonly files?: string[],
		public readonly context?: {
			committedShas?: CommittedSha[];
			pendingFiles?: string[];
		},
	) {
		super(message);
	}
}

// ── DiffHashMismatchError ────────────────────────────────────────────────────

/**
 * Thrown when the staged diff has changed between diff-capture and commit time
 * (race condition protection).
 */
export class DiffHashMismatchError extends Error {
	override name = "DiffHashMismatchError";

	constructor() {
		super("DiffHash mismatch: The staged diff changed during LLM inference.");
	}
}

// ── GitExecError ─────────────────────────────────────────────────────────────

/**
 * Thrown when a git command exits with a non-zero code and the error is
 * not recoverable by the retry loop.
 */
export class GitExecError extends Error {
	override name = "GitExecError";

	constructor(
		message: string,
		public readonly command: string,
		public readonly exitCode: number,
	) {
		super(message);
	}
}

// ── PartialCommitError ───────────────────────────────────────────────────────

/**
 * Thrown by the publisher when a mid-loop commit fails AFTER at least one
 * commit has already landed. Carries the partial state so the orchestrator
 * can merge landed SHAs and retry only the remaining work.
 */
export class PartialCommitError extends Error {
	override name = "PartialCommitError";

	constructor(
		message: string,
		public readonly context: {
			committedShas: CommittedSha[];
			originalHead: string;
			failedIndex: number;
			totalCount: number;
			pendingFiles: string[];
		},
	) {
		super(message);
	}
}

// ── PushError ────────────────────────────────────────────────────────────────

/**
 * Thrown when a git push fails.
 * `transient: true` → retryable (network blip).
 * `transient: false` → permanent (auth error, repository rejected, etc.).
 */
export class PushError extends Error {
	override name = "PushError";

	constructor(
		message: string,
		public readonly transient: boolean,
	) {
		super(message);
	}
}
