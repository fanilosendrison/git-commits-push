import { z } from "zod";
import { isFullGitObjectId } from "../modules/git/git-object-id.ts";
import type { PushSnapshot } from "../types.ts";

export const gitObjectIdSchema = z
	.string()
	.refine(isFullGitObjectId, "expected full nonzero Git object ID");
export const pushUrlFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const destinationRefSchema = z
	.string()
	.startsWith("refs/heads/")
	.refine(
		(value) =>
			value.length > "refs/heads/".length &&
			!/[\s~^:?*[\\]/u.test(value) &&
			!value.includes("..") &&
			!value.includes("@{") &&
			!value.includes("//") &&
			!value.endsWith("/") &&
			!value.endsWith(".") &&
			value
				.split("/")
				.every((part) => !part.startsWith(".") && !part.endsWith(".lock")),
		"expected valid branch ref",
	);
const endpoint = {
	remote: z.string().min(1),
	destinationRef: destinationRefSchema,
	pushUrlFingerprint: pushUrlFingerprintSchema,
};
const anchor = {
	baseRef: destinationRefSchema,
	baseSha: gitObjectIdSchema,
	observedBaseRefSha: gitObjectIdSchema,
};
export const explicitCreatePushSnapshotSchema = z
	.object({
		kind: z.literal("explicit-create"),
		...endpoint,
		...anchor,
		validatedHeadSha: gitObjectIdSchema,
		outgoingShas: z.array(gitObjectIdSchema),
	})
	.strict();
export const explicitCreateTargetSnapshotSchema = z
	.object({
		kind: z.literal("explicit-create-target"),
		...endpoint,
		...anchor,
		initialHeadSha: gitObjectIdSchema,
	})
	.strict();
const noCreation = {
	baseRef: z.never().optional(),
	baseSha: z.never().optional(),
	observedBaseRefSha: z.never().optional(),
};
const trackedPushSnapshotSchema = z.object({
	kind: z.literal("tracked"),
	sourceBranch: z.string(),
	upstreamRef: z.string(),
	...endpoint,
	...noCreation,
	validatedHeadSha: gitObjectIdSchema,
	destinationBaselineSha: gitObjectIdSchema,
	outgoingShas: z.array(gitObjectIdSchema).min(1),
});
const explicitPushSnapshotSchema = z.object({
	kind: z.literal("explicit"),
	...endpoint,
	...noCreation,
	validatedHeadSha: gitObjectIdSchema,
	destinationBaselineSha: gitObjectIdSchema,
	outgoingShas: z.array(gitObjectIdSchema).min(1),
});
/** Historical tracked snapshots alone can omit their discriminant. */
export const pushSnapshotSchema: z.ZodSchema<PushSnapshot> = z.preprocess(
	(value) => {
		if (
			typeof value === "object" &&
			value !== null &&
			!("kind" in value) &&
			"sourceBranch" in value &&
			"upstreamRef" in value
		)
			return { ...value, kind: "tracked" };
		return value;
	},
	z.discriminatedUnion("kind", [
		trackedPushSnapshotSchema,
		explicitPushSnapshotSchema,
		explicitCreatePushSnapshotSchema,
	]),
) as z.ZodSchema<PushSnapshot>;
export const explicitPushTargetSnapshotSchema = z.union([
	z.object({
		...endpoint,
		...noCreation,
		kind: z.never().optional(),
		destinationBaselineSha: gitObjectIdSchema,
	}),
	explicitCreateTargetSnapshotSchema,
]);
