import {
	gitExecArgs,
	gitExecInputArgs,
	gitExecutionProcessConfiguration,
} from "./git-exec.ts";
import type { PreparedMergeScope } from "./prepared-merge-types.ts";

export interface FrozenCommitIdentity {
	readonly name: string;
	readonly email: string;
	readonly date: string;
}

/** Parse Git's documented `git var *_IDENT` representation, never ambient authority on resume. */
export function parseCommitIdentity(identity: string): FrozenCommitIdentity {
	const match = /^([^\n<>]+) <([^\n<>]+)> ([0-9]+ [+-][0-9]{4})$/u.exec(
		identity,
	);
	if (!match?.[1] || !match[2] || !match[3])
		throw new Error("Invalid frozen Git commit identity.");
	return { name: match[1], email: match[2], date: match[3] };
}

export function readPreparedHeadReference(repository: string): string {
	try {
		return gitExecArgs(
			["symbolic-ref", "--quiet", "HEAD"],
			repository,
			gitExecutionProcessConfiguration("prepared-merge"),
		);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"status" in error &&
			error.status === 1
		)
			return "HEAD";
		throw error;
	}
}

/** Git itself hashes standard commit-object bytes without writing an object or advancing history. */
export function preparedCommitIdentity(
	scope: PreparedMergeScope,
	authorIdent: string,
	committerIdent: string,
): string {
	parseCommitIdentity(authorIdent);
	parseCommitIdentity(committerIdent);
	const object = `tree ${scope.indexTree}\nparent ${scope.firstParent}\nparent ${scope.secondParent}\nauthor ${authorIdent}\ncommitter ${committerIdent}\n\n${scope.mergeMessage}\n`;
	return gitExecInputArgs(
		["hash-object", "-t", "commit", "--stdin"],
		scope.repository,
		object,
		gitExecutionProcessConfiguration("prepared-merge"),
	).trim();
}
