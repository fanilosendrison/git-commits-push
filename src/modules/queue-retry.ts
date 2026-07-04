/**
 * src/modules/queue-retry.ts — Phase 4: queueRetry helper + retryJobs queue
 *
 * Exports:
 *   - retryJobs: module-scope queue (Decision 9, R26 invariant)
 *   - queueRetry: pure-ish function that builds a retry job and pushes it
 *
 * Plan ref: Phase 4 — queueRetry, Decision 9, R4, R5, R6, R11, R20, R28,
 *           R29, R40, R41, R65, R73, R75
 */

import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as path from "node:path";
import type {
	CommitJobPayload,
	CommitPlan,
	CommittedSha,
	Feedback,
	FeedbackError,
	RepoState,
	Settings,
} from "../types.ts";
import { formatConventionalCommit } from "./git-publisher.ts";

// ── Module-scope retry queue ─────────────────────────────────────────────────

/**
 * Module-scope retry queue (Decision 9).
 *
 * R26 invariant: Turnlock MUST guarantee that a single `commit-and-push` phase
 * instance runs at any given time per worker. If two instances interleave,
 * the `retryJobs.length = 0` reset at phase entry nukes the other instance's
 * queued jobs. The orchestrator resets this array at the start of each phase.
 */
export const retryJobs: Array<{ id: string; prompt: string }> = [];

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Default per-kind max attempts (Decision 1).
 * Plan ref: Phase 4 constants
 */
export const MAX_ATTEMPTS_BY_KIND: Record<FeedbackError["kind"], number> = {
	validation: 2,
	structural: 1,
	race: 1,
	git: 1,
	network: 1,
};

/**
 * Cap feedbackHistory at the sum of per-kind max attempts (default 5),
 * with a minimum of 10 (R44 safety floor).
 */
export const MAX_FEEDBACK_HISTORY = Math.max(
	10,
	Object.values(MAX_ATTEMPTS_BY_KIND).reduce((a, b) => a + b, 0),
);

/**
 * Per-entry byte cap (R29): a single plan with thousands of files can
 * serialize to >100 KB. Truncate each entry at 16 KB.
 */
const MAX_FEEDBACK_ENTRY_BYTES = 16 * 1024;

/**
 * Total byte cap (R65): 10 entries × 16 KB = 160 KB exceeds small-context
 * LLMs (8K tokens ≈ 32 KB). Truncate the joined string at 64 KB.
 */
const MAX_FEEDBACK_TOTAL_BYTES = 64 * 1024;

// ── logRetry ─────────────────────────────────────────────────────────────────

/**
 * Structured stderr log for retry decisions (R40).
 */
function logRetry(
	repoId: string,
	kind: FeedbackError["kind"],
	attempt: number,
	diffHash: string,
	reason: string,
): void {
	process.stderr.write(
		`[git-commits-push-tl] retry repo=${repoId} kind=${kind} attempt=${attempt}/${MAX_ATTEMPTS_BY_KIND[kind]} diffHash=${diffHash.slice(0, 12)} reason=${JSON.stringify(reason)}\n`,
	);
}

// ── QueueRetryResult ─────────────────────────────────────────────────────────

export type QueueRetryResult =
	| {
			kind: "queued";
			repoState: RepoState;
			job: { id: string; prompt: string };
	  }
	| { kind: "loop-detected"; repoState: RepoState };

// ── formatFailedPlans ─────────────────────────────────────────────────────────

/**
 * Format failed commit plans as human-readable text for the LLM feedback block.
 * Each plan is rendered as a formatted commit message followed by its file list.
 */
function formatFailedPlans(plans: CommitPlan[]): string {
	return plans
		.map((p) => {
			const msg = formatConventionalCommit(p.commit);
			const files = p.files.join(", ");
			return `${msg}\nFiles: ${files}`;
		})
		.join("\n---\n");
}

// ── queueRetry ───────────────────────────────────────────────────────────────

/**
 * Build a retry job for an LLM re-invocation.
 *
 * Pure logic (no I/O):
 *   - Loop detection via canonical plan hash
 *   - pendingFiles filtering against committedShas
 *   - feedbackHistory capping
 *   - Payload construction
 *
 * Best-effort I/O (errors caught, defaults to ""):
 *   - git diff reconstruction (worktree guard R73)
 *
 * Side effects:
 *   - Pushes to module-scope retryJobs array
 *   - Logs to stderr via logRetry
 */
export function queueRetry(
	repoId: string,
	repoState: RepoState,
	errors: FeedbackError[],
	options: {
		committedShas?: CommittedSha[];
		pendingFiles?: string[];
	},
	settings: Settings,
	systemPrompt: string,
	failedPlans: CommitPlan[],
): QueueRetryResult {
	// 1. Validate diffHash exists
	if (!repoState.diffHash) {
		throw new Error(
			`Cannot retry repo ${repoId}: missing diffHash on RepoState`,
		);
	}

	// 2. Filter pendngFiles against committedShas (R6 + R75 path normalization)
	let pendingFiles = options.pendingFiles;
	if (pendingFiles && pendingFiles.length > 0) {
		const committedFiles = new Set<string>();
		for (const cs of repoState.committedShas ?? []) {
			for (const f of cs.files) {
				committedFiles.add(path.posix.normalize(f));
			}
		}
		for (const cs of options.committedShas ?? []) {
			for (const f of cs.files) {
				committedFiles.add(path.posix.normalize(f));
			}
		}
		pendingFiles = pendingFiles.filter(
			(f) => !committedFiles.has(path.posix.normalize(f)),
		);
	}

	// 3. Reconstruct remaining diff (best-effort, R73 worktree guard)
	const remainingDiff = reconstructRemainingDiff(
		repoState.repository,
		pendingFiles,
	);

	// 4. Loop detection (R11): hash the canonical plan structure
	const canonical = failedPlans
		.map((p) => ({
			commit: {
				type: p.commit.type,
				scope: p.commit.scope ?? null,
				description: p.commit.description,
				body: p.commit.body ?? null,
				isBreaking: p.commit.isBreaking,
			},
			files: [...p.files].sort(),
		}))
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	const planHash = crypto
		.createHash("sha256")
		.update(JSON.stringify(canonical))
		.digest("hex");

	if (repoState.lastPlanHash === planHash) {
		// Same plan structure as the previous attempt → loop detected.
		// Return without consuming a retry attempt or pushing a job.
		return {
			kind: "loop-detected",
			repoState: { ...repoState, lastPlanHash: planHash },
		};
	}

	// 5. Cap feedbackHistory (R20, R29, R44, R65)
	//    Store human-readable formatted messages instead of raw canonical JSON
	//    so the LLM can see what it actually generated.
	const displayEntry = formatFailedPlans(failedPlans);
	const truncatedEntry =
		displayEntry.length > MAX_FEEDBACK_ENTRY_BYTES
			? displayEntry.slice(0, MAX_FEEDBACK_ENTRY_BYTES) + "\n[truncated]"
			: displayEntry;

	const history = repoState.feedbackHistory ?? [];
	const nextHistory = [...history, truncatedEntry];
	if (nextHistory.length > MAX_FEEDBACK_HISTORY) {
		nextHistory.splice(0, nextHistory.length - MAX_FEEDBACK_HISTORY);
	}

	const joinedHistory = nextHistory.join("\n\n--- NEXT ATTEMPT ---\n\n");
	const previousCommit =
		joinedHistory.length > MAX_FEEDBACK_TOTAL_BYTES
			? joinedHistory.slice(0, MAX_FEEDBACK_TOTAL_BYTES) + "\n[truncated]"
			: joinedHistory;

	// 6. Build payload
	const feedback: Feedback = {
		previous_commit: previousCommit,
		errors,
		committed_shas: options.committedShas,
		pending_files: pendingFiles,
	};

	const payload: CommitJobPayload = {
		repository: repoState.repository,
		diff: remainingDiff,
		diffHash: repoState.diffHash,
		provider: settings.provider,
		model: settings.model,
		temperature: settings.temperature,
		systemPrompt,
		feedback,
		thinking: settings.thinking,
	};

	// 7. Log and push
	const currentAttempt =
		repoState.attempts?.[errors[0]?.kind ?? "structural"] ?? 0;
	logRetry(
		repoId,
		errors[0]?.kind ?? "structural",
		currentAttempt,
		repoState.diffHash,
		"queueRetry",
	);

	const newRepoState: RepoState = {
		...repoState,
		lastPlanHash: planHash,
		feedbackHistory: nextHistory,
	};

	const job = { id: repoId, prompt: JSON.stringify(payload) };
	retryJobs.push(job);

	return { kind: "queued", repoState: newRepoState, job };
}

// ── reconstructRemainingDiff ─────────────────────────────────────────────────

/**
 * Reconstruct the remaining-work diff for retry or escalation contexts.
 *
 * When pendingFiles is present:
 *   - For each file, check worktree vs index (R73 worktree guard)
 *   - Re-stage safe files, capture `git diff --cached`
 *   - Reset to restore clean state
 *   - Include worktree-only diffs as-is
 *
 * When pendingFiles is empty/absent:
 *   - Best-effort read of `git diff --cached`
 *
 * Falls back to empty string if all reconstruction paths fail.
 */
function reconstructRemainingDiff(
	repoPath: string,
	pendingFiles?: string[],
): string {
	if (pendingFiles && pendingFiles.length > 0) {
		const safeToRestage: string[] = [];
		const worktreeOnlyParts: string[] = [];

		for (const f of pendingFiles) {
			try {
				const worktreeVsIndex = execSync(
					`git diff -- "${f.replace(/"/g, '\\"')}"`,
					{
						cwd: repoPath,
						encoding: "utf-8",
						stdio: ["pipe", "pipe", "pipe"],
					},
				).toString();

				if (worktreeVsIndex) {
					// R73 fix: preserve worktree edits regardless of index status
					worktreeOnlyParts.push(worktreeVsIndex);
				} else {
					safeToRestage.push(f);
				}
			} catch {
				// File missing or git error — include in safeToRestage
				// and let the re-stage fail gracefully below
				safeToRestage.push(f);
			}
		}

		if (safeToRestage.length > 0) {
			const quoted = safeToRestage.map((f) => JSON.stringify(f)).join(" ");
			try {
				execSync(`git add -- ${quoted}`, {
					cwd: repoPath,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				});
				const cachedDiff = execSync("git diff --cached", {
					cwd: repoPath,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
					timeout: 30_000,
				}).toString();
				// Reset after capture
				try {
					execSync("git reset HEAD", {
						cwd: repoPath,
						encoding: "utf-8",
						stdio: ["pipe", "pipe", "pipe"],
					});
				} catch {
					// Best-effort cleanup
				}
				return cachedDiff + worktreeOnlyParts.join("\n");
			} catch {
				// Re-stage failed — return whatever worktree diffs we have
				return worktreeOnlyParts.join("\n");
			}
		}

		return worktreeOnlyParts.join("\n");
	}

	// No pendingFiles — read the full staged diff (best-effort)
	try {
		return execSync("git diff --cached", {
			cwd: repoPath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 30_000,
		}).toString();
	} catch {
		return "";
	}
}
