import { z } from "zod";
import type {
	AttemptsByKind,
	CommitJobResult,
	CommitPlan,
	GlobalState,
} from "../types.ts";

const commitMessageStateSchema = z.object({
	type: z.string(),
	scope: z.string().optional().nullable(),
	description: z.string(),
	body: z.string().optional().nullable(),
	isBreaking: z.boolean(),
});

const commitMessageResultSchema = z.object({
	type: z.string(),
	scope: z.string().optional().nullable(),
	description: z.string(),
	body: z.string().optional().nullable(),
	isBreaking: z.boolean().optional().default(false),
});

export const commitPlanSchema: z.ZodSchema<CommitPlan> = z.object({
	commit: commitMessageStateSchema,
	files: z.array(z.string()),
});

export const commitPlanResultSchema = z.object({
	commit: commitMessageResultSchema,
	files: z.array(z.string()),
});

export const nonEmptyCommitPlanResultListSchema = z
	.array(commitPlanResultSchema)
	.min(1);

const commitJobResultRuntimeSchema = z.union([
	z.object({
		success: z.literal(true),
		id: z.string(),
		commits: z.array(commitPlanResultSchema),
	}),
	z.object({
		success: z.literal(false),
		id: z.string(),
		error: z.string(),
	}),
]);

// Turnlock consumes result files as unknown JSON, while ZodSchema<T> fixes input
// to T. This schema normalizes omitted `isBreaking` values before returning T.
export const commitJobResultSchema =
	commitJobResultRuntimeSchema as z.ZodSchema<CommitJobResult>;

const ATTEMPT_KINDS = [
	"validation",
	"structural",
	"race",
	"git",
	"network",
] as const;
type AttemptKind = (typeof ATTEMPT_KINDS)[number];

const attemptsRuntimeSchema = z.preprocess(
	(value) => {
		if (typeof value === "number") return {}; // legacy: zero out
		return value;
	},
	z
		.record(
			z
				.string()
				.refine(
					(key): key is AttemptKind =>
						ATTEMPT_KINDS.includes(key as AttemptKind),
					{
						message: `attempts key must be one of: ${ATTEMPT_KINDS.join(", ")}`,
					},
				),
			z.number().int().nonnegative(),
		)
		.optional(),
);

// Accepts the legacy persisted `attempts: number`, but normalizes to the
// current per-kind map before Turnlock stores state again.
const attemptsSchema = attemptsRuntimeSchema as z.ZodSchema<
	AttemptsByKind | undefined
>;
const gitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);

const pushSnapshotSchema = z.object({
	sourceBranch: z.string(),
	validatedHeadSha: gitObjectIdSchema,
	upstreamRef: z.string(),
	remote: z.string(),
	destinationRef: z.string(),
	destinationBaselineSha: gitObjectIdSchema,
	outgoingShas: z.array(gitObjectIdSchema).min(1),
	pushUrlFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});

const repoStateSchema = z
	.object({
		repository: z.string(),
		status: z.enum(["PENDING", "RUNNING", "SUCCESS", "FAILED"]),
		operation: z.enum(["commit-and-push", "push-only"]).optional(),
		pushSnapshot: pushSnapshotSchema.optional(),
		pushedShas: z.array(gitObjectIdSchema).optional(),
		diffHash: z.string().optional(),
		commits: z.array(commitPlanSchema).optional(),
		error: z.string().optional(),
		attempts: attemptsSchema,
		committedShas: z
			.array(z.object({ sha: z.string(), files: z.array(z.string()) }))
			.optional(),
		originalHead: z.string().optional(),
		feedbackHistory: z.array(z.string()).optional(),
		lastPlanHash: z.string().optional(),
		loopDetected: z
			.object({
				kind: z.enum(["validation", "structural", "race", "git", "network"]),
				planHash: z.string(),
			})
			.optional(),
		fallbackAttempted: z.boolean().optional(),
	})
	.superRefine((repoState, context) => {
		if (repoState.operation === "push-only") {
			if (!repoState.pushSnapshot) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "push-only state requires a durable push snapshot",
					path: ["pushSnapshot"],
				});
			}
			if (repoState.status === "SUCCESS") {
				const expectedShas = repoState.pushSnapshot?.outgoingShas;
				if (
					!repoState.pushedShas ||
					!expectedShas ||
					repoState.pushedShas.length !== expectedShas.length ||
					repoState.pushedShas.some((sha, index) => sha !== expectedShas[index])
				) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message:
							"successful push-only state requires the complete checkpointed object IDs",
						path: ["pushedShas"],
					});
				}
			}
			return;
		}
		if (repoState.pushSnapshot || repoState.pushedShas) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "push-only evidence requires operation=push-only",
				path: [repoState.pushSnapshot ? "pushSnapshot" : "pushedShas"],
			});
		}
	});

export const stateSchema: z.ZodSchema<GlobalState> = z.object({
	repos: z.record(z.string(), repoStateSchema),
});
