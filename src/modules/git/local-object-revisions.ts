import { gitExecActualGraphArgs } from "./git-exec.ts";

/** Git 2.17 local-only traversal, actual parentage, no promisor retrieval or metadata edits. */
export function readLocalObjectRevisions(
	repository: string,
	args: readonly string[],
): string {
	return gitExecActualGraphArgs(
		["rev-list", "--missing=print", ...args, "--"],
		repository,
	);
}
