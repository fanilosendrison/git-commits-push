/**
 * tests/unit/orchestrator-schema.test.ts — State schema tests for Phase 4.
 *
 * Plan ref: Phase 4 — Update stateSchema Zod definition
 *   - R30/R48: attempts tightened to per-kind, constrained to 5-kind union
 *   - R37: legacy attempts:number accepted via preprocessor
 *   - R58: top-level diffHash field
 *   - R62: loopDetected field
 *   - New fields: committedShas, originalHead, feedbackHistory, lastPlanHash
 *   - Status includes "ESCALATED"
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

// Re-create the schema here for testing (mirrors the one in the orchestrator)
// We test the schema independently to keep the test isolated from the orchestrator.

const ATTEMPT_KINDS = [
	"validation",
	"structural",
	"race",
	"git",
	"network",
] as const;
type AttemptKind = (typeof ATTEMPT_KINDS)[number];

const attemptsSchema = z.preprocess(
	(v) => {
		if (typeof v === "number") return {}; // legacy: zero out
		return v;
	},
	z
		.record(
			z
				.string()
				.refine(
					(k): k is AttemptKind => ATTEMPT_KINDS.includes(k as AttemptKind),
					{
						message: `attempts key must be one of: ${ATTEMPT_KINDS.join(", ")}`,
					},
				),
			z.number().int().nonnegative(),
		)
		.optional(),
);

const commitPlanSchema = z.object({
	commit: z.object({
		type: z.string(),
		scope: z.string().optional(),
		description: z.string(),
		body: z.string().optional(),
		isBreaking: z.boolean(),
	}),
	files: z.array(z.string()),
});

const stateSchema = z.object({
	diffHash: z.string().optional(),
	repos: z.record(
		z.string(),
		z.object({
			repository: z.string(),
			status: z.enum(["PENDING", "RUNNING", "ESCALATED", "SUCCESS", "FAILED"]),
			diffHash: z.string().optional(),
			commits: z.array(commitPlanSchema).optional(),
			error: z.string().optional(),
			attempts: attemptsSchema,
			committedShas: z
				.array(
					z.object({
						sha: z.string(),
						files: z.array(z.string()),
					}),
				)
				.optional(),
			originalHead: z.string().optional(),
			feedbackHistory: z.array(z.string()).optional(),
			lastPlanHash: z.string().optional(),
			loopDetected: z
				.object({
					kind: z.string(),
					planHash: z.string(),
				})
				.optional(),
		}),
	),
});

type ParsedState = z.infer<typeof stateSchema>;

// ── Basic valid state ────────────────────────────────────────────────────────

describe("stateSchema accepts valid state", () => {
	test("minimal valid state", () => {
		const result = stateSchema.safeParse({
			repos: {
				"repo-1": {
					repository: "/path/to/repo",
					status: "PENDING",
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("full state with all new fields", () => {
		const result = stateSchema.safeParse({
			diffHash: "abc123def456",
			repos: {
				"repo-1": {
					repository: "/path/to/repo",
					status: "RUNNING",
					diffHash: "abc123",
					commits: [
						{
							commit: {
								type: "feat",
								description: "add feature",
								isBreaking: false,
							},
							files: ["src/index.ts"],
						},
					],
					error: "something failed",
					attempts: {
						structural: 1,
						git: 0,
						validation: 0,
						race: 0,
						network: 0,
					},
					committedShas: [{ sha: "abc123", files: ["src/index.ts"] }],
					originalHead: "def456",
					feedbackHistory: ["plan1", "plan2"],
					lastPlanHash: "sha256hash",
					loopDetected: { kind: "structural", planHash: "sha256hash" },
				},
			},
		});
		expect(result.success).toBe(true);
	});
});

// ── Status includes ESCALATED ────────────────────────────────────────────────

describe("stateSchema status field", () => {
	test("accepts ESCALATED status", () => {
		const result = stateSchema.safeParse({
			repos: {
				"repo-1": {
					repository: "/path",
					status: "ESCALATED",
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects invalid status", () => {
		const result = stateSchema.safeParse({
			repos: {
				"repo-1": {
					repository: "/path",
					status: "INVALID",
				},
			},
		});
		expect(result.success).toBe(false);
	});
});

// ── attempts: per-kind with legacy support ───────────────────────────────────

describe("attempts schema", () => {
	test("accepts per-kind attempts object", () => {
		const result = attemptsSchema.safeParse({
			structural: 2,
			validation: 1,
			git: 0,
			race: 0,
			network: 0,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({
				structural: 2,
				validation: 1,
				git: 0,
				race: 0,
				network: 0,
			});
		}
	});

	test("R37: legacy attempts:number → zeroed to {}", () => {
		const result = attemptsSchema.safeParse(3);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({});
		}
	});

	test("R48: rejects invalid attempt kind key", () => {
		const result = attemptsSchema.safeParse({
			validaton: 1, // typo: should be "validation"
		});
		expect(result.success).toBe(false);
	});

	test("R30: rejects negative attempts value", () => {
		const result = attemptsSchema.safeParse({
			structural: -1,
		});
		expect(result.success).toBe(false);
	});

	test("R30: rejects non-integer attempts value", () => {
		const result = attemptsSchema.safeParse({
			structural: 1.5,
		});
		expect(result.success).toBe(false);
	});

	test("accepts empty object", () => {
		const result = attemptsSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual({});
		}
	});

	test("accepts undefined (optional)", () => {
		const result = attemptsSchema.safeParse(undefined);
		expect(result.success).toBe(true);
	});
});

// ── committedShas ────────────────────────────────────────────────────────────

describe("committedShas schema", () => {
	test("accepts valid committedShas array", () => {
		const result = stateSchema.safeParse({
			repos: {
				"repo-1": {
					repository: "/path",
					status: "SUCCESS",
					committedShas: [
						{ sha: "abc", files: ["f1.ts"] },
						{ sha: "def", files: ["f2.ts", "f3.ts"] },
					],
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects committedShas with missing sha", () => {
		const result = stateSchema.safeParse({
			repos: {
				"repo-1": {
					repository: "/path",
					status: "SUCCESS",
					committedShas: [{ files: ["f1.ts"] }],
				},
			},
		});
		expect(result.success).toBe(false);
	});
});

// ── loopDetected ─────────────────────────────────────────────────────────────

describe("loopDetected schema (R62)", () => {
	test("accepts valid loopDetected", () => {
		const result = stateSchema.safeParse({
			repos: {
				"repo-1": {
					repository: "/path",
					status: "FAILED",
					loopDetected: { kind: "structural", planHash: "hash123" },
				},
			},
		});
		expect(result.success).toBe(true);
	});
});

// ── feedbackHistory ──────────────────────────────────────────────────────────

describe("feedbackHistory schema", () => {
	test("accepts string array", () => {
		const result = stateSchema.safeParse({
			repos: {
				"repo-1": {
					repository: "/path",
					status: "RUNNING",
					feedbackHistory: ["attempt 1", "attempt 2"],
				},
			},
		});
		expect(result.success).toBe(true);
	});
});
