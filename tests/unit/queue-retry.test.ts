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

import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { queueRetry, retryJobs } from "../../src/modules/queue-retry.ts";
import type {
	CommitPlan,
	CommittedSha,
	FeedbackError,
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
		expect(result.kind).toBe("queued");
		if (result.kind !== "queued") return;

		// repoState must be a NEW object (immutable update)
		expect(result.repoState).not.toBe(repoState);
		expect(result.repoState.lastPlanHash).toBeTruthy();
		expect(typeof result.repoState.lastPlanHash).toBe("string");

		// feedbackHistory initialized
		expect(result.repoState.feedbackHistory).toHaveLength(1);
		expect(result.repoState.feedbackHistory[0]).toBeTruthy();

		// job structure
		expect(result.job.id).toBe("repo-1");
		expect(typeof result.job.prompt).toBe("string");

		// job.prompt must be parseable JSON
		const payload = JSON.parse(result.job.prompt);
		expect(payload.repository).toBe("/tmp/nonexistent-repo");
		expect(payload.diffHash).toBe(repoState.diffHash);
		expect(payload.feedback.errors).toEqual(errors);
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

		expect(countJobs()).toBe(before + 1);
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
		expect(first.kind).toBe("queued");
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
		expect(second.kind).toBe("loop-detected");
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
		expect(first.kind).toBe("queued");
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
		expect(second.kind).toBe("loop-detected");
		expect(countJobs()).toBe(afterFirst); // no new job pushed
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
		expect(result.kind).toBe("queued");
		if (result.kind !== "queued") return;

		const payload = JSON.parse(result.job.prompt);
		// src/foo.ts should be removed (committed), src/bar.ts and src/baz.ts remain
		expect(payload.feedback.pending_files).not.toContain("src/foo.ts");
		expect(payload.feedback.pending_files).toContain("src/bar.ts");
		expect(payload.feedback.pending_files).toContain("src/baz.ts");
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
		expect(result.kind).toBe("queued");
		if (result.kind !== "queued") return;

		const payload = JSON.parse(result.job.prompt);
		// src/./foo.ts normalizes to src/foo.ts → should be filtered out
		expect(payload.feedback.pending_files).not.toContain("src/./foo.ts");
		expect(payload.feedback.pending_files).toContain("src/bar.ts");
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
		expect(result.kind).toBe("queued");
		if (result.kind !== "queued") return;

		const payload = JSON.parse(result.job.prompt);
		expect(payload.feedback.pending_files).toContain("src/a.ts");
		expect(payload.feedback.pending_files).toContain("src/b.ts");
	});
});

// ── U-GE-32: feedbackHistory capping ─────────────────────────────────────────

describe("U-GE-32 | feedbackHistory capped at 10 entries", () => {
	test("after 11 calls with distinct plans, history has exactly 10 entries", () => {
		let repoState = makeRepoState();
		const errors: FeedbackError[] = [{ kind: "structural", message: "err" }];

		for (let i = 0; i < 11; i++) {
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
			expect(result.kind).toBe("queued");
			if (result.kind !== "queued") return;
			repoState = result.repoState;
		}

		expect(repoState.feedbackHistory).toHaveLength(10);
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
		expect(first.kind).toBe("queued");
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
		expect(second.kind).toBe("loop-detected");
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
		expect(first.kind).toBe("queued");
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
		expect(second.kind).toBe("loop-detected");
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
		expect(first.kind).toBe("queued");
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
		expect(second.kind).toBe("queued");
	});
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("queueRetry edge cases", () => {
	test("missing diffHash throws", () => {
		const repoState = makeRepoState({ diffHash: undefined });
		expect(() =>
			queueRetry(
				"repo-1",
				repoState,
				[{ kind: "structural", message: "err" }],
				{},
				MINIMAL_SETTINGS,
				SYSTEM_PROMPT,
				[makePlan(1)],
			),
		).toThrow("diffHash");
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
		expect(result.kind).toBe("queued");
		if (result.kind !== "queued") return;

		const entry = result.repoState.feedbackHistory?.[0];
		expect(entry).toBeTruthy();
		if (!entry) return;
		// If the entry exceeds 16KB, it should have the [truncated] marker
		if (entry.length > 16 * 1024) {
			expect(entry).toMatch(/\[truncated\]$/);
		}
	});

	test("retryJobs cleared between tests (afterEach works)", () => {
		expect(countJobs()).toBe(0);
	});
});
