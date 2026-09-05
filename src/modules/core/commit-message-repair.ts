import { z } from "zod";
import type {
	CommitMessage,
	CommitMessageRepairPayload,
	CommitPlan,
} from "../../types.ts";
import { MAX_COMMIT_SUBJECT_LENGTH } from "./validators/commit-message-validator.ts";

const repairItemSchema = z
	.object({
		planIndex: z.number().int().nonnegative(),
		commit: z
			.object({
				type: z.string(),
				scope: z.string().nullable().optional(),
				description: z.string(),
				body: z.string().nullable().optional(),
				isBreaking: z.boolean(),
			})
			.strict(),
	})
	.strict();

export const COMMIT_MESSAGE_REPAIR_SYSTEM_PROMPT = `You repair Conventional Commit messages.
Return only a JSON array of objects shaped as {"planIndex": number, "commit": CommitMessage}.
Return exactly one object for every requested planIndex and no other indexes.
Never return files or alter file ownership. Preserve intent and unaffected fields.
Every fully formatted subject must be at most ${MAX_COMMIT_SUBJECT_LENGTH} characters.
Move nonessential detail into the body instead of truncating words.`;

export function formatCommitMessageRepairPrompt(
	payload: CommitMessageRepairPayload,
): string {
	const requestedIndexes = [
		...new Set(
			payload.validationErrors
				.map((error) => error.planIndex)
				.filter((index): index is number => index !== undefined),
		),
	].sort((left, right) => left - right);
	const plans = requestedIndexes.map((planIndex) => ({
		planIndex,
		commit: payload.rejectedPlans[planIndex]?.commit,
	}));
	return JSON.stringify({
		task: "repair-commit-messages",
		maximumSubjectLength: MAX_COMMIT_SUBJECT_LENGTH,
		plans,
		errors: payload.validationErrors,
	});
}

export function mergeCommitMessageRepairs(
	payload: CommitMessageRepairPayload,
	response: unknown,
): CommitPlan[] {
	const repairs = z.array(repairItemSchema).parse(response);
	const expectedIndexes = [
		...new Set(
			payload.validationErrors
				.map((error) => error.planIndex)
				.filter((index): index is number => index !== undefined),
		),
	].sort((left, right) => left - right);
	const actualIndexes = repairs
		.map((repair) => repair.planIndex)
		.sort((left, right) => left - right);
	if (
		actualIndexes.length !== expectedIndexes.length ||
		actualIndexes.some((index, position) => index !== expectedIndexes[position])
	) {
		throw new Error(
			"Commit-message repair response does not match the requested plan indexes.",
		);
	}

	for (const repair of repairs) {
		const rejectedCommit = payload.rejectedPlans[repair.planIndex]?.commit;
		if (
			!rejectedCommit ||
			repair.commit.type !== rejectedCommit.type ||
			(repair.commit.scope ?? null) !== (rejectedCommit.scope ?? null) ||
			repair.commit.isBreaking !== rejectedCommit.isBreaking
		) {
			throw new Error(
				"Commit-message repair changed protected semantic fields.",
			);
		}
	}

	const repairedMessages = new Map<number, CommitMessage>(
		repairs.map((repair) => [repair.planIndex, repair.commit]),
	);
	return payload.rejectedPlans.map((plan, planIndex) => ({
		commit: repairedMessages.get(planIndex) ?? plan.commit,
		files: [...plan.files],
	}));
}
