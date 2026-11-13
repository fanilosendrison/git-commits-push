import { z } from "zod";
import type { CommitJobResult } from "../../types.ts";
import { contextOverflowReceiptSchema } from "../llm/context-overflow.ts";
import { planningBudgetSchema } from "../llm/planning-attempt-budget.ts";
import {
	isTerminalProviderFailureKind,
	PROVIDER_FAILURE_KINDS,
	type TerminalProviderFailureKind,
} from "../llm/provider-failure.ts";

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
		planningBudget: planningBudgetSchema.optional(),
		success: z.literal(true),
		id: z.string(),
		commits: z.array(commitPlanResultSchema),
	}),
	z
		.object({
			planningBudget: planningBudgetSchema.optional(),
			success: z.literal(false),
			id: z.string(),
			error: z.string(),
			contextOverflow: contextOverflowReceiptSchema.optional(),
			providerFailureKind: z.enum(PROVIDER_FAILURE_KINDS).optional(),
			planningFailureKind: z.literal("structural").optional(),
			terminalFailureKind: z
				.custom<TerminalProviderFailureKind>(isTerminalProviderFailureKind)
				.optional(),
			rejectedPlans: z.array(commitPlanResultSchema).min(1).optional(),
		})
		.refine(
			(result) =>
				[
					result.providerFailureKind,
					result.planningFailureKind,
					result.terminalFailureKind,
				].filter(Boolean).length <= 1 &&
				(!result.contextOverflow ||
					result.terminalFailureKind === "invalid_request"),
			"Failure classifications cannot grant combined retry authority",
		),
]);

// Normalize omitted result isBreaking before returning the existing public type.
export const commitJobResultSchema =
	commitJobResultRuntimeSchema as z.ZodSchema<CommitJobResult>;
