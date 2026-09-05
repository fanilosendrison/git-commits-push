import { z } from "zod";

const turnlockV2BatchManifestSchema = z.object({
	manifestVersion: z.literal(2),
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
	worker: z.string().min(1).optional(),
	jobs: z
		.array(
			z.object({
				id: z.string().min(1),
				prompt: z.string(),
				resultPath: z.string().min(1),
			}),
		)
		.min(1),
});

export type TurnlockBatchManifest = z.infer<
	typeof turnlockV2BatchManifestSchema
>;

/** Parse and validate the supported Turnlock v2 batch manifest. */
export function parseTurnlockV2BatchManifest(
	content: string,
): TurnlockBatchManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error("Turnlock delegation manifest is not valid JSON");
	}
	const result = turnlockV2BatchManifestSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(
			"Turnlock delegation manifest is not a valid v2 batch manifest",
		);
	}
	return result.data;
}
