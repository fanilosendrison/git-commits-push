import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as path from "node:path";
import type {
	CommitJobPayload,
	CommitMessageRepairPayload,
	CommitPlan,
	CommittedSha,
	Feedback,
	FeedbackError,
	RepoState,
	Settings,
} from "../../types.ts";
import { formatConventionalCommit } from "../formatters/commit-formatter.ts";
import { reconstructRemainingDiff } from "../git/diff.ts";

// ── Module-scope retry queue ─────────────────────────────────────────────────

export const retryJobs: Array<{ id: string; prompt: string }> = [];

// ── Constants ────────────────────────────────────────────────────────────────

export const MAX_ATTEMPTS_BY_KIND: Record<FeedbackError["kind"], number> = {
	validation: 2,
	structural: 1,
	race: 1,
	git: 1,
	network: 1,
};

export const MAX_FEEDBACK_HISTORY = Math.max(
	10,
	Object.values(MAX_ATTEMPTS_BY_KIND).reduce((a, b) => a + b, 0),
);

const MAX_FEEDBACK_ENTRY_BYTES = 16 * 1024;
const MAX_FEEDBACK_TOTAL_BYTES = 64 * 1024;

// ── logRetry ─────────────────────────────────────────────────────────────────

function logRetry(
	repoId: string,
	kind: FeedbackError["kind"],
	attempt: number,
	diffHash: string,
	reason: string,
	model?: string,
): void {
	process.stderr.write(
		`[git-commits-push-tl] retry repo=${repoId} kind=${kind} attempt=${attempt}/${MAX_ATTEMPTS_BY_KIND[kind]} model=${model ?? "?"} diffHash=${diffHash.slice(0, 12)} reason=${JSON.stringify(reason)}\n`,
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

function formatFailedPlans(plans: CommitPlan[]): string {
	return plans
		.map((p) => {
			const msg = formatConventionalCommit(p.commit);
			const files = p.files.join(", ");
			return `${msg}\nFiles: ${files}`;
		})
		.join("\n---\n");
}

function hashPlans(plans: CommitPlan[]): string {
	const canonical = plans
		.map((plan) => ({
			commit: {
				type: plan.commit.type,
				scope: plan.commit.scope ?? null,
				description: plan.commit.description,
				body: plan.commit.body ?? null,
				isBreaking: plan.commit.isBreaking,
			},
			files: [...plan.files].sort(),
		}))
		.sort((left, right) =>
			JSON.stringify(left).localeCompare(JSON.stringify(right)),
		);
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(canonical))
		.digest("hex");
}

function appendFeedbackHistory(
	history: string[] | undefined,
	failedPlans: CommitPlan[],
): { nextHistory: string[]; previousCommit: string } {
	const displayEntry = formatFailedPlans(failedPlans);
	const truncatedEntry =
		displayEntry.length > MAX_FEEDBACK_ENTRY_BYTES
			? `${displayEntry.slice(0, MAX_FEEDBACK_ENTRY_BYTES)}\n[truncated]`
			: displayEntry;
	const nextHistory = [...(history ?? []), truncatedEntry];
	if (nextHistory.length > MAX_FEEDBACK_HISTORY) {
		nextHistory.splice(0, nextHistory.length - MAX_FEEDBACK_HISTORY);
	}
	const joinedHistory = nextHistory.join("\n\n--- NEXT ATTEMPT ---\n\n");
	return {
		nextHistory,
		previousCommit:
			joinedHistory.length > MAX_FEEDBACK_TOTAL_BYTES
				? `${joinedHistory.slice(0, MAX_FEEDBACK_TOTAL_BYTES)}\n[truncated]`
				: joinedHistory,
	};
}

function queueCommitMessageRepair(
	repoId: string,
	repoState: RepoState,
	errors: FeedbackError[],
	settings: Settings,
	systemPrompt: string,
	failedPlans: CommitPlan[],
): QueueRetryResult {
	const diffHash = repoState.diffHash;
	if (!diffHash) {
		throw new Error(
			`Cannot repair repo ${repoId}: missing diffHash on RepoState`,
		);
	}
	const planHash = hashPlans(failedPlans);
	if (repoState.lastPlanHash === planHash) {
		return {
			kind: "loop-detected",
			repoState: { ...repoState, lastPlanHash: planHash },
		};
	}

	const { nextHistory } = appendFeedbackHistory(
		repoState.feedbackHistory,
		failedPlans,
	);
	const payload: CommitMessageRepairPayload = {
		mode: "repair-commit-messages",
		repository: repoState.repository,
		diffHash,
		provider: settings.provider,
		model: settings.model,
		temperature: settings.temperature,
		systemPrompt,
		rejectedPlans: failedPlans,
		validationErrors: errors,
		thinking: settings.thinking,
		agent: settings.agent,
	};
	const currentAttempt = repoState.attempts?.validation ?? 0;
	logRetry(
		repoId,
		"validation",
		currentAttempt,
		diffHash,
		"queueCommitMessageRepair",
		settings.model,
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

// ── queueRetry ───────────────────────────────────────────────────────────────

export function queueRetry(
	repoId: string,
	repoState: RepoState,
	errors: FeedbackError[],
	options: {
		committedShas?: CommittedSha[] | undefined;
		pendingFiles?: string[] | undefined;
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

	if (
		failedPlans.length > 0 &&
		errors.length > 0 &&
		errors.every((error) => error.kind === "validation")
	) {
		return queueCommitMessageRepair(
			repoId,
			repoState,
			errors,
			settings,
			systemPrompt,
			failedPlans,
		);
	}

	// 2. Filter pendingFiles against committedShas (path normalization)
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

	// 3. Reconstruct remaining diff (best-effort)
	const remainingDiff = reconstructRemainingDiff(
		repoState.repository,
		pendingFiles,
	);

	// 3.5 Re-stage files and recompute diffHash
	let actualDiff = remainingDiff;
	try {
		if (pendingFiles && pendingFiles.length > 0) {
			const quoted = pendingFiles.map((f) => JSON.stringify(f)).join(" ");
			execSync(`git add -- ${quoted}`, {
				cwd: repoState.repository,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
		} else {
			execSync("git add -A", {
				cwd: repoState.repository,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
		}
		actualDiff = execSync("git diff --cached", {
			cwd: repoState.repository,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).toString();
	} catch {
		// Fallback to remainingDiff
	}
	const newDiffHash = crypto
		.createHash("sha256")
		.update(actualDiff)
		.digest("hex");

	// 4. Loop detection
	const planHash = hashPlans(failedPlans);

	if (repoState.lastPlanHash === planHash) {
		return {
			kind: "loop-detected",
			repoState: { ...repoState, lastPlanHash: planHash },
		};
	}

	// 5. Cap feedbackHistory
	const { nextHistory, previousCommit } = appendFeedbackHistory(
		repoState.feedbackHistory,
		failedPlans,
	);

	// 6. Build payload
	const feedback: Feedback = {
		previous_commit: previousCommit,
		errors,
		committed_shas: options.committedShas,
		pending_files: pendingFiles,
	};

	const payload: CommitJobPayload = {
		repository: repoState.repository,
		diff: actualDiff,
		diffHash: newDiffHash,
		provider: settings.provider,
		model: settings.model,
		temperature: settings.temperature,
		systemPrompt,
		feedback,
		thinking: settings.thinking,
		agent: settings.agent,
	};

	// 7. Log and push
	const currentAttempt =
		repoState.attempts?.[errors[0]?.kind ?? "structural"] ?? 0;
	logRetry(
		repoId,
		errors[0]?.kind ?? "structural",
		currentAttempt,
		newDiffHash,
		"queueRetry",
		settings.model,
	);

	const newRepoState: RepoState = {
		...repoState,
		lastPlanHash: planHash,
		feedbackHistory: nextHistory,
		diffHash: newDiffHash,
	};

	const job = { id: repoId, prompt: JSON.stringify(payload) };
	retryJobs.push(job);

	return { kind: "queued", repoState: newRepoState, job };
}
