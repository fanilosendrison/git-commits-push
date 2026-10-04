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

function formatProtectedSubjectPrefix(commit: CommitMessage): string {
	let prefix = commit.type;
	if (commit.scope) {
		prefix += `(${commit.scope})`;
	}
	if (commit.isBreaking) {
		prefix += "!";
	}
	return `${prefix}: `;
}

function maximumDescriptionLength(commit: CommitMessage): number {
	return Math.max(
		0,
		MAX_COMMIT_SUBJECT_LENGTH - formatProtectedSubjectPrefix(commit).length,
	);
}

function fitRepairDescriptionToBudget(
	description: string,
	maximumLength: number,
): string {
	if (description.length <= maximumLength) {
		return description;
	}

	let boundary = description.lastIndexOf(" ", maximumLength);
	while (boundary > 0 && description[boundary - 1] === " ") {
		boundary = description.lastIndexOf(" ", boundary - 1);
	}
	if (boundary <= 0) {
		throw new Error(
			"Commit-message repair description exceeds its protected subject budget and no whole-word prefix fits.",
		);
	}
	return description.slice(0, boundary);
}

export const COMMIT_MESSAGE_REPAIR_SYSTEM_PROMPT = `You repair Conventional Commit messages.
Return only a JSON array of objects shaped as {"planIndex": number, "commit": CommitMessage}.
Return exactly one object for every requested planIndex and no other indexes.
Never return files or alter file ownership.
Preserve type, scope, isBreaking, and body exactly.
Each requested plan includes subjectPrefix and maximumDescriptionLength.
The subjectPrefix already accounts for type, scope, the breaking marker, and ": ".
Set commit.description to at most that plan's maximumDescriptionLength characters.
Count only commit.description characters against maximumDescriptionLength.
Every fully formatted subject must be at most ${MAX_COMMIT_SUBJECT_LENGTH} characters.
Preserve body exactly.
Do not move removed or nonessential subject detail into the body.
Shorten only commit.description when necessary without truncating words.`;

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
	const plans = requestedIndexes.map((planIndex) => {
		const rejectedPlan = payload.rejectedPlans[planIndex];
		if (!rejectedPlan) {
			throw new Error(
				`Commit-message repair references missing plan index ${planIndex}.`,
			);
		}

		return {
			planIndex,
			commit: rejectedPlan.commit,
			subjectPrefix: formatProtectedSubjectPrefix(rejectedPlan.commit),
			maximumDescriptionLength: maximumDescriptionLength(rejectedPlan.commit),
		};
	});
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

	const repairedMessages = new Map<number, CommitMessage>();
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

		const descriptionLimit = maximumDescriptionLength(rejectedCommit);
		const description = fitRepairDescriptionToBudget(
			repair.commit.description,
			descriptionLimit,
		);
		if (description.length > descriptionLimit) {
			throw new Error(
				`Commit-message repair description exceeds protected subject budget for plan ${repair.planIndex}: ${description.length}/${descriptionLimit}.`,
			);
		}
		repairedMessages.set(repair.planIndex, {
			...rejectedCommit,
			description,
		});
	}

	return payload.rejectedPlans.map((plan, planIndex) => ({
		commit: repairedMessages.get(planIndex) ?? plan.commit,
		files: [...plan.files],
	}));
}
