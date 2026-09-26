import * as path from "node:path";
import { z } from "zod";
import type {
	AttemptsByKind,
	CommitJobResult,
	CommitPlan,
	ExplicitPushTargetSnapshot,
	GlobalState,
	InvocationScope,
	PushSnapshot,
} from "../types.ts";
import { REMOTE_TRACKING_REF_SYNCHRONIZATION_OUTCOMES } from "../types.ts";

const BRANCH_REF_PREFIX = "refs/heads/";

const destinationRefSchema = z
	.string()
	.startsWith(BRANCH_REF_PREFIX)
	.refine((value) => value.length > BRANCH_REF_PREFIX.length, {
		message: "push destination must name a branch",
	});

/**
 * Structural validation only: no filesystem access and no Git subprocess.
 * Canonical worktree existence, configured-remote membership, and Git ref
 * format are proven by the invocation-scope module before durable work starts.
 */
const invocationScopeSchema: z.ZodSchema<InvocationScope> =
	z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("global") }),
		z.object({
			kind: z.literal("worktree"),
			repository: z
				.string()
				.min(1)
				.refine((value) => path.isAbsolute(value), {
					message: "worktree repository must be an absolute path",
				}),
		}),
		z.object({
			kind: z.literal("targeted"),
			repository: z
				.string()
				.min(1)
				.refine((value) => path.isAbsolute(value), {
					message: "targeted repository must be an absolute path",
				}),
			pushRemote: z.string().min(1),
			pushRef: z
				.string()
				.startsWith(BRANCH_REF_PREFIX)
				.refine((value) => value.length > BRANCH_REF_PREFIX.length, {
					message: "targeted push ref must name a branch",
				}),
		}),
	]);

// Historical valid Turnlock state predates targeted mode and is semantically
// global; a missing invocationScope normalizes to global. A malformed present
// value still fails validation.
const invocationScopeWithGlobalDefault: z.ZodSchema<InvocationScope> =
	z.preprocess(
		(value) => (value === undefined ? { kind: "global" } : value),
		invocationScopeSchema,
	) as unknown as z.ZodSchema<InvocationScope>;

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
const pushUrlFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const trackedPushSnapshotSchema = z.object({
	kind: z.literal("tracked"),
	sourceBranch: z.string(),
	validatedHeadSha: gitObjectIdSchema,
	upstreamRef: z.string(),
	remote: z.string(),
	destinationRef: destinationRefSchema,
	destinationBaselineSha: gitObjectIdSchema,
	outgoingShas: z.array(gitObjectIdSchema).min(1),
	pushUrlFingerprint: pushUrlFingerprintSchema,
});

const explicitPushSnapshotSchema = z.object({
	kind: z.literal("explicit"),
	validatedHeadSha: gitObjectIdSchema,
	remote: z.string(),
	destinationRef: destinationRefSchema,
	destinationBaselineSha: gitObjectIdSchema,
	outgoingShas: z.array(gitObjectIdSchema).min(1),
	pushUrlFingerprint: pushUrlFingerprintSchema,
});

// Historical valid Turnlock state predates explicit publication: a structurally
// valid tracked snapshot without a discriminant normalizes to `tracked`. No
// historical state can be an explicit snapshot, so a missing discriminant is
// never interpreted as one, and a present but invalid discriminant fails.
const pushSnapshotRuntimeSchema = z.preprocess(
	(value) => {
		if (
			typeof value === "object" &&
			value !== null &&
			!("kind" in value) &&
			"sourceBranch" in value &&
			"upstreamRef" in value
		) {
			return { ...(value as Record<string, unknown>), kind: "tracked" };
		}
		return value;
	},
	z.discriminatedUnion("kind", [
		trackedPushSnapshotSchema,
		explicitPushSnapshotSchema,
	]),
);

const pushSnapshotSchema = pushSnapshotRuntimeSchema as z.ZodSchema<
	PushSnapshot | undefined
>;

const explicitPushTargetSnapshotSchema = z.object({
	remote: z.string(),
	destinationRef: destinationRefSchema,
	destinationBaselineSha: gitObjectIdSchema,
	pushUrlFingerprint: pushUrlFingerprintSchema,
});

const repoStateSchema = z
	.object({
		repository: z.string(),
		status: z.enum(["PENDING", "RUNNING", "SUCCESS", "FAILED"]),
		operation: z.enum(["commit-and-push", "push-only"]).optional(),
		pushSnapshot: pushSnapshotSchema.optional(),
		explicitPushTargetSnapshot: explicitPushTargetSnapshotSchema.optional(),
		pushedShas: z.array(gitObjectIdSchema).optional(),
		publishedSha: gitObjectIdSchema.optional(),
		remoteTrackingRefSynchronization: z
			.enum(REMOTE_TRACKING_REF_SYNCHRONIZATION_OUTCOMES)
			.optional(),
		diffHash: z.string().optional(),
		commits: z.array(commitPlanSchema).optional(),
		error: z.string().optional(),
		attempts: attemptsSchema,
		committedShas: z
			.array(z.object({ sha: z.string(), files: z.array(z.string()) }))
			.optional(),
		originalHead: z.string().nullable().optional(),
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
		if (repoState.remoteTrackingRefSynchronization && !repoState.publishedSha) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					"remote-tracking synchronization evidence requires a verified publication SHA",
				path: ["remoteTrackingRefSynchronization"],
			});
		}
		if (repoState.operation === "push-only") {
			if (repoState.explicitPushTargetSnapshot) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message:
						"push-only evidence must not carry a frozen commit-and-push target",
					path: ["explicitPushTargetSnapshot"],
				});
			}
			if (!repoState.pushSnapshot) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "push-only state requires a durable push snapshot",
					path: ["pushSnapshot"],
				});
			} else if (
				repoState.publishedSha !== undefined &&
				repoState.publishedSha !== repoState.pushSnapshot.validatedHeadSha
			) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message:
						"published SHA must match the checkpointed validated head for push-only evidence",
					path: ["publishedSha"],
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
export const stateSchema: z.ZodSchema<GlobalState> = z
	.object({
		invocationScope: invocationScopeWithGlobalDefault,
		repos: z.record(z.string(), repoStateSchema),
	})
	.superRefine((state, context) => {
		const scope = state.invocationScope;
		for (const [repoId, repoState] of Object.entries(state.repos)) {
			const path = ["repos", repoId] as const;
			if (scope.kind === "global") {
				if (repoState.explicitPushTargetSnapshot) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message:
							"a global invocation must not carry a frozen explicit push target",
						path: [...path, "explicitPushTargetSnapshot"],
					});
				}
				if (repoState.pushSnapshot?.kind === "explicit") {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message:
							"a global invocation must not carry an explicit push snapshot",
						path: [...path, "pushSnapshot"],
					});
				}
				continue;
			}

			if (scope.kind === "worktree") {
				if (repoState.repository !== scope.repository) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message:
							"a worktree invocation may only persist state for its exact worktree",
						path: [...path, "repository"],
					});
				}
				if (repoState.explicitPushTargetSnapshot) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message:
							"a worktree invocation must not carry a frozen explicit push target",
						path: [...path, "explicitPushTargetSnapshot"],
					});
				}
				if (repoState.pushSnapshot?.kind === "explicit") {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message:
							"a worktree invocation must not carry an explicit push snapshot",
						path: [...path, "pushSnapshot"],
					});
				}
				continue;
			}

			if (repoState.repository !== scope.repository) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message:
						"a targeted invocation may only persist state for its exact worktree",
					path: [...path, "repository"],
				});
			}
			if (repoState.operation === "commit-and-push") {
				if (!repoState.explicitPushTargetSnapshot) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message:
							"targeted commit-and-push state requires a frozen explicit push target",
						path: [...path, "explicitPushTargetSnapshot"],
					});
				}
			}
			for (const [field, snapshot] of explicitDestinationFields(repoState)) {
				if (
					snapshot.remote !== scope.pushRemote ||
					snapshot.destinationRef !== scope.pushRef
				) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message:
							"frozen explicit destination must match the targeted invocation scope",
						path: [...path, field],
					});
				}
			}
		}
	});

/** Every field of one repo that names an explicit publication destination. */
function explicitDestinationFields(repoState: {
	readonly explicitPushTargetSnapshot?: ExplicitPushTargetSnapshot | undefined;
	readonly pushSnapshot?: PushSnapshot | undefined;
}): ReadonlyArray<
	readonly [
		string,
		{ readonly remote: string; readonly destinationRef: string },
	]
> {
	const fields: Array<
		readonly [
			string,
			{ readonly remote: string; readonly destinationRef: string },
		]
	> = [];
	if (repoState.explicitPushTargetSnapshot) {
		fields.push([
			"explicitPushTargetSnapshot",
			repoState.explicitPushTargetSnapshot,
		]);
	}
	if (repoState.pushSnapshot?.kind === "explicit") {
		fields.push(["pushSnapshot", repoState.pushSnapshot]);
	}
	return fields;
}
