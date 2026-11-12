import { z } from "zod";
import type {
	ExplicitPublicationTargetSnapshot,
	ValidatedSourceWitness,
} from "../types.ts";
import { preparedMergeSourceSchema } from "./prepared-merge-state-schema.ts";
import { gitObjectIdSchema } from "./publication-state-schema.ts";

/** Optional only for historical parsing, never optional commit authority. */
export const validatedSourceWitnessSchema = z
	.object({
		repository: z.string(),
		gitDirectory: z.string(),
		baseHeadSha: gitObjectIdSchema.nullable(),
		expectedTreeSha: gitObjectIdSchema,
		fullDiffHash: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		expectedChangedPaths: z
			.array(z.string().min(1))
			.refine((paths) => new Set(paths).size === paths.length),
		publicationRequired: z.boolean(),
		preparedMerge: preparedMergeSourceSchema.optional(),
	})
	.strict();

/** Explicit destination authority can never be downgraded into local-only success. */
export function witnessPublicationIntentIssue(
	witness: ValidatedSourceWitness | undefined,
	target: ExplicitPublicationTargetSnapshot | undefined,
): string | undefined {
	if (witness && target && !witness.publicationRequired)
		return "Explicit publication requires publicationRequired=true in the validated-source witness.";
	return undefined;
}
