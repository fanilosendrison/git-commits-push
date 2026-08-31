/**
 * tests/unit/queue-retry.test.ts — Tests for queueRetry helper (Phase 4)
 *
 * Plan reference: §7.4b Queue-retry tests (U-GE-26 through U-GE-33)
 *
 * queueRetry has three categories of behavior:
 *   A. Pure logic (no I/O): loop detection, pendingFiles filtering, capping
 *   B. I/O (best-effort):   diff reconstruction via execSync/gitExec
 *   C. Side effects:        push to retryJobs, stderr logging
 *
 * Tests A and C use dummy repo paths (execSync fallback returns "").
 * Tests B use GitRepoFixture (real git repos).
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { queueRetry, retryJobs } from "../../src/modules/core/queue-retry.ts";
import type {
	CommitPlan,
	CommittedSha,
	FeedbackError,
	RepoState,
	Settings,
} from "../../src/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

const MINIMAL_SETTINGS: Settings = {
	searchPaths: [],
	provider: "openai",
	model: "gpt-4",
	temperature: 0,
	systemPromptPath: "/dev/null",
	autoPush: false,
	skipTests: true,
};

const SYSTEM_PROMPT = "You are a commit assistant.";

function makePlan(
	id: number,
	files: string[] = [`file${id}.ts`],
	type: string = "feat",
	description: string = `change ${id}`,
): CommitPlan {
	return {
		commit: {
			type,
			description,
			isBreaking: false,
		},
		files,
	};
}

function makeRepoState(overrides: Record<string, unknown> = {}) {
	return {
		repository: "/tmp/nonexistent-repo",
		status: "RUNNING" as const,
		diffHash:
			"abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
		...overrides,
	};
}

function countJobs(): number {
	return retryJobs.length;
}

afterEach(() => {
	retryJobs.length = 0;
});

// ── U-GE-26: Basic queue ─────────────────────────────────────────────────────

describe("U-GE-26 | queueRetry basic queued result", () => {
	test("returns { kind: 'queued' } with updated repoState and a job", () => {
		const repoState = makeRepoState();
		const errors: FeedbackError[] = [
			{ kind: "structural", message: "duplicate file" },
		];

		const result = queueRetry(
			"repo-1",
			repoState,
			errors,
			{},
			MINIMAL_SETTINGS,
			SYSTEM_PROMPT,
			[makePlan(1)],
		);

		// Must be queued
		assert.strictEqual(result.kind, "queued");
		if (result.kind !== "queued") return;

		// repoState must be a NEW object (immutable update)
		assert.notStrictEqual(result.repoState, repoState);
		assert.ok(result.repoState.lastPlanHash);
		assert.strictEqual(typeof result.repoState.lastPlanHash, "string");

		// feedbackHistory initialized
		assert.strictEqual(result.repoState.feedbackHistory?.length, 1);
		assert.ok(result.repoState.feedbackHistory?.[0]);

		// job structure
		assert.strictEqual(result.job.id, "repo-1");
		assert.strictEqual(typeof result.job.prompt, "string");

		// job.prompt must be parseable JSON
		const payload = JSON.parse(result.job.prompt);
		assert.strictEqual(payload.repository, "/tmp/nonexistent-repo");
		assert.strictEqual(typeof payload.diffHash, "string");
		assert.deepStrictEqual(payload.feedback.errors, errors);
	});

	test("retryJobs contains the job after queueRetry", () => {
		const repoState = makeRepoState();
		const before = countJobs();

		queueRetry(
			"repo-1",
			repoState,
			[{ kind: "structural", message: "err" }],
			{},
			MINIMAL_SETTINGS,
			SYSTEM_PROMPT,
			[makePlan(1)],
		);

		assert.strictEqual(countJobs(), before + 1);
	});

	test("retry payload includes agent when settings.agent is set", () => {
		const settingsWithAgent: Settings = {
			...MINIMAL_SETTINGS,
			agent: "git-commits-push",
		};
		const repoState = makeRepoState();

		const result = queueRetry(
			"repo-1",
			repoState,
			[{ kind: "structural", message: "err" }],
			{},
			settingsWithAgent,
			SYSTEM_PROMPT,
			[makePlan(1)],
		);

		assert.strictEqual(result.kind, "queued");
		if (result.kind !== "queued") return;

		const payload = JSON.parse(result.job.prompt);
		assert.strictEqual(payload.agent, "git-commits-push");
	});

	test("retry payload omits agent when settings.agent is not set", () => {
		const repoState = makeRepoState();

		const result = queueRetry(
			"repo-1",
			repoState,
			[{ kind: "structural", message: "err" }],
			{},
			MINIMAL_SETTINGS,
			SYSTEM_PROMPT,
			[makePlan(1)],
		);

		assert.strictEqual(result.kind, "queued");
		if (result.kind !== "queued") return;

		const payload = JSON.parse(result.job.prompt);
		assert.strictEqual(payload.agent, undefined);
	});
});

// ── U-GE-27: Loop detection ─────────────────────────────────────────────────

describe("U-GE-27 | queueRetry loop detection", () => {
	test("second call with identical plan returns { kind: 'loop-detected' }", () => {
		const repoState = makeRepoState();
		const errors: FeedbackError[] = [
			{ kind: "structural", message: "duplicate file" },
		];
		const plan = makePlan(1);

		// First call — queued
		const first = queueRetry(
			"repo-1",
			repoState,
			errors,
			{},
			MINIMAL_SETTINGS,
			SYSTEM_PROMPT,
			[plan],
		);
		assert.strictEqual(first.kind, "queued");
		if (first.kind !== "queued") return;

		// Second call with same plan — loop detected
		const second = queueRetry(
			"repo-1",
			first.repoState,
			errors,
			{},
			MINIMAL_SETTINGS,
			SYSTEM_PROMPT,
			[plan],
		);
		assert.strictEqual(second.kind, "loop-detected");
	});

	test("no job pushed on loop detection", () => {
		const repoState = makeRepoState();
		const plan = makePlan(1);
		const errors: FeedbackError[] = [{ kind: "structural", message: "err" }];

		const first = queueRetry(
			"r",
			repoState,
			errors,
			{},
			MINIMAL_SETTINGS,
			SYSTEM_PROMPT,
			[plan],
		);
		assert.strictEqual(first.kind, "queued");
		const afterFirst = countJobs();

		if (first.kind !== "queued") return;
		const second = queueRetry(
			"r",
			first.repoState,
			errors,
			{},
			MINIMAL_SETTINGS,
			SYSTEM_PROMPT,
			[plan],
		);
		assert.strictEqual(second.kind, "loop-detected");
		assert.strictEqual(countJobs(), afterFirst); // no new job pushed
	});
});

// ── U-GE-31: pendingFiles filtering ──────────────────────────────────────────

describe("U-GE-31 | pendingFiles filtered against committedShas", () => {
	test("committed files removed from pendingFiles", () => {
		const committedShas: CommittedSha[] = [
			{ sha: "abc", files: ["src/foo.ts"] },
		];
		const repoState = makeRepoState({ committedShas });

		const result = queueRetry(
			"repo-1",
			repoState,
			[{ kind: "structural", message: "missing" }],
			{
				pendingFiles: ["src/foo.ts", "src/bar.ts", "src/baz.ts"],
			},
			MINIMAL_SETTINGS,
			SYSTEM_PROMPT,
			[makePlan(1)],
		);
		assert.strictEqual(result.kind, "queued");
		if (result.kind !== "queued") return;

		const payload = JSON.parse(result.job.prompt);
		// src/foo.ts should be removed (committed), src/bar.ts and src/baz.ts remain
		assert.ok(!payload.feedback.pending_files.includes("src/foo.ts"));
		assert.ok(payload.feedback.pending_files.includes("src/bar.ts"));
		assert.ok(payload.feedback.pending_files.includes("src/baz.ts"));
	});

	test("R75: path normalization catches src/./foo.ts vs src/foo.ts", () => {
		const committedShas: CommittedSha[] = [
			{ sha: "abc", files: ["src/foo.ts"] },
		];
		const repoState = makeRepoState({ committedShas });

		const result = queueRetry(
			"repo-1",
			repoState,
			[{ kind: "structural", message: "missing" }],
			{
				pendingFiles: ["src/./foo.ts", "src/bar.ts"],
			},
			MINIMAL_SETTINGS,
			SYSTEM_PROMPT,
			[makePlan(1)],
		);
		assert.strictEqual(result.kind, "queued");
		if (result.kind !== "queued") return;

		const payload = JSON.parse(result.job.prompt);
		// src/./foo.ts normalizes to src/foo.ts → should be filtered out
		assert.ok(!payload.feedback.pending_files.includes("src/./foo.ts"));
		assert.ok(payload.feedback.pending_files.includes("src/bar.ts"));
	});

	test("no committedShas → pending_files unchanged", () => {
		const repoState = makeRepoState(); // no committedShas

		const result = queueRetry(
			"repo-1",
			repoState,
			[{ kind: "structural", message: "missing" }],
			{
				pendingFiles: ["src/a.ts", "src/b.ts"],
			},
			MINIMAL_SETTINGS,
			SYSTEM_PROMPT,
			[makePlan(1)],
		);
		assert.strictEqual(result.kind, "queued");
		if (result.kind !== "queued") return;

		const payload = JSON.parse(result.job.prompt);
		assert.ok(payload.feedback.pending_files.includes("src/a.ts"));
		assert.ok(payload.feedback.pending_files.includes("src/b.ts"));
	});
});

// ── U-GE-32: feedbackHistory capping ─────────────────────────────────────────

describe("U-GE-32 | feedbackHistory capped at MAX_FEEDBACK_HISTORY", () => {
	test("after 15 calls with distinct plans, history respects the cap", () => {
		let repoState: RepoState = makeRepoState();
		const errors: FeedbackError[] = [{ kind: "structural", message: "err" }];

		// Make more calls than the default cap (which is 14 with current MAX_ATTEMPTS)
		for (let i = 0; i < 18; i++) {
			const plan = makePlan(i, [`file${i}.ts`], "feat", `change ${i}`);
			const result = queueRetry(
				"repo-1",
				repoState,
				errors,
				{},
				MINIMAL_SETTINGS,
				SYSTEM_PROMPT,
				[plan],
			);
			assert.strictEqual(result.kind, "queued");
			if (result.kind !== "queued") return;
			repoState = result.repoState;
		}

		// MAX_FEEDBACK_HISTORY = Math.max(10, sum of all MAX_ATTEMPTS_BY_KIND)
		// With validation=10, others=1: sum=14, so max=14
		// After 18 calls, history should be capped at 14
		assert.ok((repoState.feedbackHistory?.length ?? 0) <= 14);
	});
});

// ── U-GE-33: Same structure, different wording → loop detected ──────────────

describe("U-GE-33 | same structure different wording → loop detected", () => {
	test("identical plans → loop detected", () => {
		const repoState = makeRepoState();
		const errors: FeedbackError[] = [{ kind: "structural", message: "err" }];

		const plan: CommitPlan = {
			commit: {
				type: "feat",
				description: "add feature",
				isBreaking: false,
				body: "Explanation.",
			},
			files: ["src/a.ts", "src/b.ts"],
		};

		const first = queueRetry(
			"repo-1",
			repoState,
			errors,
			{},
			MINIMAL_SETTINGS,
			SYSTEM_PROMPT,
			[plan],
		);
		assert.strictEqual(first.kind, "queued");
		if (first.kind !== "queued") return;

		const second = queueRetry(
			"repo-1",
			first.repoState,
			errors,
			{},
			MINIMAL_SETTINGS,
			SYSTEM_PROMPT,
			[plan],
		);
		assert.strictEqual(second.kind, "loop-detected");
	});

	test("files sorted differently → loop detected (canonical sort)", () => {
		const repoState = makeRepoState();
		const errors: FeedbackError[] = [{ kind: "structural", message: "err" }];

		const planA: CommitPlan = {
			commit: { type: "feat", description: "add", isBreaking: false },
			files: ["src/z.ts", "src/a.ts"],
		};

		const first = queueRetry(
			"repo-1",
			repoState,
			errors,
			{},
			MINIMAL_SETTINGS,
			SYSTEM_PROMPT,
			[planA],
		);
		assert.strictEqual(first.kind, "queued");
		if (first.kind !== "queued") return;

		// Same files in different order → canonical sort normalizes them → same hash
		const planB: CommitPlan = {
			commit: { type: "feat", description: "add", isBreaking: false },
			files: ["src/a.ts", "src/z.ts"],
		};

		const second = queueRetry(
			"repo-1",
			first.repoState,
			errors,
			{},
			MINIMAL_SETTINGS,
			SYSTEM_PROMPT,
			[planB],
		);
		assert.strictEqual(second.kind, "loop-detected");
	});

	test("different files → different hash → queued (not loop)", () => {
		const repoState = makeRepoState();
		const errors: FeedbackError[] = [{ kind: "structural", message: "err" }];

		const first = queueRetry(
			"repo-1",
			repoState,
			errors,
			{},
			MINIMAL_SETTINGS,
			SYSTEM_PROMPT,
			[makePlan(1, ["a.ts"])],
		);
		assert.strictEqual(first.kind, "queued");
		if (first.kind !== "queued") return;

		const second = queueRetry(
			"repo-1",
			first.repoState,
			errors,
			{},
			MINIMAL_SETTINGS,
			SYSTEM_PROMPT,
			[makePlan(2, ["b.ts"])],
		);
		assert.strictEqual(second.kind, "queued");
	});
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("queueRetry edge cases", () => {
	test("missing diffHash throws", () => {
		const repoState = makeRepoState({ diffHash: undefined });
		assert.throws(
			() =>
				queueRetry(
					"repo-1",
					repoState,
					[{ kind: "structural", message: "err" }],
					{},
					MINIMAL_SETTINGS,
					SYSTEM_PROMPT,
					[makePlan(1)],
				),
			(error: unknown) =>
				error instanceof Error && error.message.includes("diffHash"),
		);
	});

	test("feedbackHistory entry truncated at MAX_FEEDBACK_ENTRY_BYTES", () => {
		const repoState = makeRepoState();
		// Create a plan with huge files array to produce a large serialized string
		const hugeFiles = Array.from(
			{ length: 2000 },
			(_, i) => `src/modules/module${i}/file${i}.ts`,
		);
		const hugePlan: CommitPlan = {
			commit: { type: "feat", description: "huge", isBreaking: false },
			files: hugeFiles,
		};

		const result = queueRetry(
			"repo-1",
			repoState,
			[{ kind: "structural", message: "err" }],
			{},
			MINIMAL_SETTINGS,
			SYSTEM_PROMPT,
			[hugePlan],
		);
		assert.strictEqual(result.kind, "queued");
		if (result.kind !== "queued") return;

		const entry = result.repoState.feedbackHistory?.[0];
		assert.ok(entry);
		if (!entry) return;
		// If the entry exceeds 16KB, it should have the [truncated] marker
		if (entry.length > 16 * 1024) {
			assert.match(entry, /\[truncated\]$/);
		}
	});

	test("retryJobs cleared between tests (afterEach works)", () => {
		assert.strictEqual(countJobs(), 0);
	});
});
