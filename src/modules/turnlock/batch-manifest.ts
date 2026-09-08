import { z } from "zod";

const AUTHORIZED_WORKER_NAME = "git-commit-generator" as const;

const turnlockBatchJobSchema = z
	.object({
		id: z.string().min(1),
		prompt: z.string(),
		resultPath: z.string().min(1),
	})
	.strict();

const commonBatchManifestShape = {
	runId: z.string().min(1),
	orchestratorName: z.string().min(1),
	phase: z.string().min(1),
	resumeAt: z.string().min(1),
	label: z.string().min(1),
	kind: z.literal("batch"),
	emittedAt: z.string().min(1),
	emittedAtEpochMs: z.number().finite(),
	timeoutMs: z.number().positive(),
	deadlineAtEpochMs: z.number().finite(),
	attempt: z.number().int().nonnegative(),
	maxAttempts: z.number().int().positive(),
	jobs: z.array(turnlockBatchJobSchema).min(1),
} as const;

const turnlockV2BatchManifestSchema = z
	.object({
		...commonBatchManifestShape,
		manifestVersion: z.literal(2),
		worker: z.literal(AUTHORIZED_WORKER_NAME),
	})
	.strict();

const turnlockV3BatchManifestSchema = z
	.object({
		...commonBatchManifestShape,
		manifestVersion: z.literal(3),
		target: z
			.object({
				kind: z.literal("worker"),
				name: z.literal(AUTHORIZED_WORKER_NAME),
			})
			.strict(),
		targetCompatibility: z.literal("legacy-v2").optional(),
	})
	.strict();

const supportedTurnlockBatchManifestSchema = z.discriminatedUnion(
	"manifestVersion",
	[turnlockV2BatchManifestSchema, turnlockV3BatchManifestSchema],
);

export type TurnlockBatchManifest = z.infer<
	typeof supportedTurnlockBatchManifestSchema
>;

/**
 * Parse and authorize a Turnlock batch manifest.
 *
 * New v3 manifests and bounded historical v2 manifests may execute only the
 * logical `git-commit-generator` capability. Physical resolution to the LLM
 * runtime remains owned by this bridge. Every other target fails closed.
 */
export function parseTurnlockBatchManifest(
	content: string,
): TurnlockBatchManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error("Turnlock delegation manifest is not valid JSON");
	}
	const result = supportedTurnlockBatchManifestSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(
			"Turnlock delegation manifest is not an authorized v2/v3 batch manifest",
		);
	}
	return result.data;
}
