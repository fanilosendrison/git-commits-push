import { z } from "zod";
import type { CommitJobResult } from "../../types.ts";
import { PROVIDER_FAILURE_KINDS } from "../llm/provider-failure.ts";

const commitMessageResultSchema = z.object({
	type: z.string(),
	scope: z.string().optional().nullable(),
	description: z.string(),
	body: z.string().optional().nullable(),
	isBreaking: z.boolean().optional().default(false),
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
		providerFailureKind: z.enum(PROVIDER_FAILURE_KINDS).optional(),
		rejectedPlans: z.array(commitPlanResultSchema).min(1).optional(),
	}),
]);

// Normalize omitted result isBreaking before returning the existing public type.
export const commitJobResultSchema =
	commitJobResultRuntimeSchema as z.ZodSchema<CommitJobResult>;
