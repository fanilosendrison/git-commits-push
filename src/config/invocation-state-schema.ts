import * as path from "node:path";
import { z } from "zod";
import type { InvocationScope } from "../types.ts";
import { preparedMergeMessageSchema } from "./prepared-merge-state-schema.ts";
import {
	destinationRefSchema,
	gitObjectIdSchema,
} from "./publication-state-schema.ts";

const repository = z
	.string()
	.min(1)
	.refine(
		(value) => path.isAbsolute(value),
		"repository must be an absolute path",
	);
const target = {
	repository,
	pushRemote: z.string().min(1),
	pushRef: destinationRefSchema,
};
const noCreation = {
	baseRef: z.never().optional(),
	baseSha: z.never().optional(),
	firstParent: z.never().optional(),
	secondParent: z.never().optional(),
	indexTree: z.never().optional(),
	mergeMessage: z.never().optional(),
};
/** Pure structural authority. Runtime scope resolution separately proves Git membership. */
const invocationScopeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("global"), ...noCreation }),
	z.object({ kind: z.literal("worktree"), repository, ...noCreation }),
	z.object({ kind: z.literal("targeted"), ...target, ...noCreation }),
	z
		.object({
			kind: z.literal("targeted-create"),
			...target,
			baseRef: destinationRefSchema,
			baseSha: gitObjectIdSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("prepared-merge"),
			...target,
			firstParent: gitObjectIdSchema,
			secondParent: gitObjectIdSchema,
			indexTree: gitObjectIdSchema,
			mergeMessage: preparedMergeMessageSchema,
		})
		.strict(),
]);
/** Missing historical scope is non-executable global state, never creation. */
export const invocationScopeWithGlobalDefault = z.preprocess(
	(value) => (value === undefined ? { kind: "global" } : value),
	invocationScopeSchema,
) as z.ZodSchema<InvocationScope>;
