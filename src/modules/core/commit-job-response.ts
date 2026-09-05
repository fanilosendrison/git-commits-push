import { nonEmptyCommitPlanResultListSchema } from "../../config/state-schema.ts";
import type { CommitJobPayload, CommitPlan } from "../../types.ts";
import { mergeCommitMessageRepairs } from "./commit-message-repair.ts";

/** Parse one LLM response and enforce mode-specific result invariants. */
export function parseCommitJobResponse(
	payload: CommitJobPayload,
	response: string,
): CommitPlan[] {
	const parsedResponse: unknown = JSON.parse(response);
	if (!Array.isArray(parsedResponse) || parsedResponse.length === 0) {
		throw new Error(
			"LLM returned an invalid response: expected a non-empty JSON array.",
		);
	}
	return payload.mode === "repair-commit-messages"
		? mergeCommitMessageRepairs(payload, parsedResponse)
		: nonEmptyCommitPlanResultListSchema.parse(parsedResponse);
}
