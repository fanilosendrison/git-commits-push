import type { CommitMessage } from "../../types.ts";

/**
 * Format a CommitMessage into a Conventional Commits string.
 * Pure function — no I/O, no side effects.
 */
export function formatConventionalCommit(commit: CommitMessage): string {
	let message = commit.type;
	if (commit.scope) {
		message += `(${commit.scope})`;
	}
	if (commit.isBreaking) {
		message += "!";
	}
	message += `: ${commit.description}`;

	if (commit.body) {
		message += `\n\n${commit.body}`;
	}

	return message;
}
