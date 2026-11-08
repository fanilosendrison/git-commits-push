import { z } from "zod";
import type { AttemptsByKind, CommitPlan, GlobalState } from "../types.ts";
import { REMOTE_TRACKING_REF_SYNCHRONIZATION_OUTCOMES } from "../types.ts";
import { validateCreationStateRelations } from "./creation-state-relations.ts";
import { invocationScopeWithGlobalDefault } from "./invocation-state-schema.ts";
import { validatePreparedMergeRelations } from "./prepared-merge-state-schema.ts";
import {
	explicitCreatePushSnapshotSchema,
	explicitPushTargetSnapshotSchema,
	gitObjectIdSchema,
	pushSnapshotSchema,
} from "./publication-state-schema.ts";
import {
	validatedSourceWitnessSchema,
	witnessPublicationIntentIssue,
} from "./validated-source-state-schema.ts";

const commitMessageStateSchema = z.object({
	type: z.string(),
	scope: z.string().optional().nullable(),
	description: z.string(),
	body: z.string().optional().nullable(),
	isBreaking: z.boolean(),
});
export const commitPlanSchema: z.ZodSchema<CommitPlan> = z.object({
	commit: commitMessageStateSchema,
	files: z.array(z.string()),
});
export {
	commitJobResultSchema,
	commitPlanResultSchema,
	nonEmptyCommitPlanResultListSchema,
} from "../modules/turnlock/job-result-schema.ts";

const ATTEMPT_KINDS = [
	"validation",
	"structural",
	"race",
	"git",
	"network",
	"provider",
] as const;
type AttemptKind = (typeof ATTEMPT_KINDS)[number];
const attemptsSchema = z.preprocess(
	(value) => (typeof value === "number" ? {} : value),
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
) as z.ZodSchema<AttemptsByKind | undefined>;

const repoStateSchema = z
	.object({
		repository: z.string(),
		validatedSource: validatedSourceWitnessSchema.optional(),
		publisherIndexTreeSha: gitObjectIdSchema.optional(),
		commitCompletion: z
			.object({
				finalHeadSha: gitObjectIdSchema,
				finalTreeSha: gitObjectIdSchema,
			})
			.strict()
			.optional(),
		status: z.enum(["PENDING", "RUNNING", "SUCCESS", "FAILED"]),
		operation: z.enum(["commit-and-push", "push-only"]).optional(),
		pushSnapshot: pushSnapshotSchema.optional(),
		explicitPushTargetSnapshot: explicitPushTargetSnapshotSchema.optional(),
		creationPublicationSnapshot: explicitCreatePushSnapshotSchema.optional(),
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
			.object({ kind: z.enum(ATTEMPT_KINDS), planHash: z.string() })
			.optional(),
		fallbackAttempted: z.boolean().optional(),
	})
	.superRefine((repo, context) => {
		const issue = (message: string, field: string) =>
			context.addIssue({ code: z.ZodIssueCode.custom, message, path: [field] });
		const intentIssue = witnessPublicationIntentIssue(
			repo.validatedSource,
			repo.explicitPushTargetSnapshot,
		);
		if (intentIssue) issue(intentIssue, "validatedSource");
		if (repo.publisherIndexTreeSha && !repo.validatedSource)
			issue(
				"publisher index progress requires the original validated-source witness",
				"publisherIndexTreeSha",
			);
		if (
			repo.commitCompletion &&
			(!repo.validatedSource ||
				repo.commitCompletion.finalTreeSha !==
					repo.validatedSource.expectedTreeSha)
		)
			issue(
				"completion requires the original validated complete tree",
				"commitCompletion",
			);
		if (
			repo.validatedSource &&
			(repo.validatedSource.repository !== repo.repository ||
				repo.operation !== "commit-and-push")
		)
			issue(
				"validated source must bind its exact commit-and-push repository",
				"validatedSource",
			);
		if (
			repo.validatedSource &&
			repo.status === "SUCCESS" &&
			(!repo.commitCompletion ||
				(repo.validatedSource.publicationRequired &&
					repo.publishedSha !== repo.commitCompletion.finalHeadSha))
		)
			issue(
				"successful witnessed state requires complete content and required publication evidence",
				"commitCompletion",
			);
		if (
			repo.validatedSource &&
			repo.originalHead !== undefined &&
			repo.originalHead !== repo.validatedSource.baseHeadSha
		)
			issue("original HEAD must retain the validated baseline", "originalHead");
		if (repo.remoteTrackingRefSynchronization && !repo.publishedSha)
			issue(
				"remote-tracking synchronization evidence requires a verified publication SHA",
				"remoteTrackingRefSynchronization",
			);
		if (repo.operation === "push-only") {
			if (repo.explicitPushTargetSnapshot)
				issue(
					"push-only evidence must not carry a frozen commit-and-push target",
					"explicitPushTargetSnapshot",
				);
			if (!repo.pushSnapshot)
				issue(
					"push-only state requires a durable push snapshot",
					"pushSnapshot",
				);
			else if (
				repo.publishedSha !== undefined &&
				repo.publishedSha !== repo.pushSnapshot.validatedHeadSha
			)
				issue(
					"published SHA must match the checkpointed validated head for push-only evidence",
					"publishedSha",
				);
			if (repo.status === "SUCCESS") {
				const expected = repo.pushSnapshot?.outgoingShas;
				if (
					!repo.pushedShas ||
					!expected ||
					repo.pushedShas.length !== expected.length ||
					repo.pushedShas.some((sha, i) => sha !== expected[i])
				)
					issue(
						"successful push-only state requires the complete checkpointed object IDs",
						"pushedShas",
					);
			}
		} else if (repo.pushSnapshot || repo.pushedShas) {
			issue(
				"push-only evidence requires operation=push-only",
				repo.pushSnapshot ? "pushSnapshot" : "pushedShas",
			);
		}
	});

/** Parse historical state without granting new authority; creation relations are fail closed. */
export const stateSchema: z.ZodSchema<GlobalState> = z
	.object({
		invocationScope: invocationScopeWithGlobalDefault,
		repos: z.record(z.string(), repoStateSchema),
	})
	.superRefine((state, context) => {
		const scope = state.invocationScope;
		if (
			scope.kind === "prepared-merge" &&
			scope.firstParent === scope.secondParent
		)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Prepared merge requires distinct ordered parents.",
				path: ["invocationScope"],
			});
		if (
			(scope.kind === "targeted-create" || scope.kind === "prepared-merge") &&
			Object.keys(state.repos).length > 1
		)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "creation state may contain only one exact repository record",
				path: ["repos"],
			});
		for (const [id, repo] of Object.entries(state.repos)) {
			const issue = (message: string, field: string) =>
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message,
					path: ["repos", id, field],
				});
			if (scope.kind !== "global" && repo.repository !== scope.repository)
				issue(
					`a ${scope.kind} invocation may only persist state for its exact worktree`,
					"repository",
				);
			validatePreparedMergeRelations(scope, repo, issue);
			validateCreationStateRelations(scope, repo, issue);
			if (scope.kind === "targeted-create") continue;
			if (scope.kind === "global" || scope.kind === "worktree") {
				if (repo.explicitPushTargetSnapshot)
					issue(
						`a ${scope.kind} invocation must not carry a frozen explicit push target`,
						"explicitPushTargetSnapshot",
					);
				if (repo.pushSnapshot?.kind === "explicit")
					issue(
						`a ${scope.kind} invocation must not carry an explicit push snapshot`,
						"pushSnapshot",
					);
				continue;
			}
			if (
				repo.operation === "commit-and-push" &&
				!repo.explicitPushTargetSnapshot
			)
				issue(
					"targeted commit-and-push state requires a frozen explicit push target",
					"explicitPushTargetSnapshot",
				);
			for (const [field, snapshot] of [
				["explicitPushTargetSnapshot", repo.explicitPushTargetSnapshot],
				[
					"pushSnapshot",
					repo.pushSnapshot?.kind === "explicit"
						? repo.pushSnapshot
						: undefined,
				],
			] as const) {
				if (
					snapshot &&
					(snapshot.remote !== scope.pushRemote ||
						snapshot.destinationRef !== scope.pushRef)
				)
					issue(
						"frozen explicit destination must match the targeted invocation scope",
						field,
					);
			}
		}
	});
