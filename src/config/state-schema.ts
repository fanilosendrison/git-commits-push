import { z } from "zod";

export const commitMessageSchema = z.object({
	type: z.string(),
	scope: z.string().optional().nullable(),
	description: z.string(),
	body: z.string().optional().nullable(),
	isBreaking: z.boolean().optional().default(false),
});

export const commitPlanSchema = z.object({
	commit: commitMessageSchema,
	files: z.array(z.string()),
});

export const commitJobResultSchema = z.union([
	z.object({
		success: z.literal(true),
		id: z.string(),
		commits: z.array(commitPlanSchema),
	}),
	z.object({
		success: z.literal(false),
		id: z.string(),
		error: z.string(),
	}),
]);

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

export const stateSchema = z.object({
	repos: z.record(
		z.string(),
		z.object({
			repository: z.string(),
			status: z.enum(["PENDING", "RUNNING", "SUCCESS", "FAILED"]),
			diffHash: z.string().optional(),
			commits: z.array(commitPlanSchema).optional(),
			error: z.string().optional(),
			// CHANGED: per-kind counter (was z.number()); accepts legacy via preprocessor
			attempts: attemptsSchema,
			// NEW: cumulative across retries
			committedShas: z
				.array(z.object({ sha: z.string(), files: z.array(z.string()) }))
				.optional(),
			// NEW
			originalHead: z.string().optional(),
			// NEW: rolling previous_commit history
			feedbackHistory: z.array(z.string()).optional(),
			// NEW: loop detection
			lastPlanHash: z.string().optional(),
			// R62 fix: dedicated loopDetected field
			loopDetected: z
				.object({
					kind: z.enum(["validation", "structural", "race", "git", "network"]),
					planHash: z.string(),
				})
				.optional(),
			fallbackAttempted: z.boolean().optional(),
		}),
	),
});
