import type { CommitPlan, FeedbackError } from "../../types.ts";
import { formatConventionalCommit } from "../formatters/commit-formatter.ts";
import {
	MAX_COMMIT_SUBJECT_LENGTH,
	validateCommitMessage,
} from "./validators/commit-message-validator.ts";

/** Produce structured validation feedback for commit-message repair. */
export function collectCommitMessageValidationErrors(
	plans: readonly CommitPlan[],
): FeedbackError[] {
	const errors: FeedbackError[] = [];
	for (const [planIndex, plan] of plans.entries()) {
		const message = formatConventionalCommit(plan.commit);
		const subject = message.split("\n")[0] ?? "";
		for (const errorMessage of validateCommitMessage(message).errors) {
			const exceedsSubjectLimit = errorMessage.startsWith(
				"Subject line trop long:",
			);
			errors.push({
				kind: "validation",
				message: `${errorMessage} on "${subject}"`,
				resolution_hint:
					"Rewrite only this commit message while preserving its file list and intent.",
				planIndex,
				rule: exceedsSubjectLimit ? "subject-max-length" : "commit-message",
				rejectedSubject: subject,
				...(exceedsSubjectLimit
					? {
							actualLength: subject.length,
							maximumLength: MAX_COMMIT_SUBJECT_LENGTH,
						}
					: {}),
			});
		}
	}
	return errors;
}
