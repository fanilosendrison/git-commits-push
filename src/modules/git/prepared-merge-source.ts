import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ValidatedSourceWitness } from "../../types.ts";
import {
	type GitExecutionPolicy,
	gitExecArgs,
	gitExecArgsRaw,
	gitExecutionProcessConfiguration,
} from "./git-exec.ts";
import { isFullGitObjectId } from "./git-object-id.ts";
import { readLocalObjectRevisions } from "./local-object-revisions.ts";

function mergeHeadPath(
	repository: string,
	executionPolicy: GitExecutionPolicy = "inherit",
): string {
	return path.resolve(
		repository,
		gitExecArgs(
			["rev-parse", "--git-path", "MERGE_HEAD"],
			repository,
			gitExecutionProcessConfiguration(executionPolicy),
		),
	);
}

/** Historical publication never consumes caller merge state implicitly. */
export function assertNoPreparedMerge(repository: string): void {
	try {
		lstatSync(mergeHeadPath(repository));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	throw new Error(
		"MERGE_HEAD requires explicit --publish-prepared-merge authority; preserving caller merge state.",
	);
}

/** Exactly one direct commit identity, with no octopus or revision-expression compatibility. */
export function readPreparedMergeHead(repository: string): string {
	const file = mergeHeadPath(repository, "prepared-merge");
	if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
		throw new Error("MERGE_HEAD must be a regular file.");
	const raw = readFileSync(file, "utf8");
	const sha = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
	if (!isFullGitObjectId(sha))
		throw new Error(
			"MERGE_HEAD must contain exactly one full commit identity.",
		);
	return sha;
}

/** Bind the complete resolved index membership, not just the changed subset. */
export function readPreparedIndexDigest(repository: string): string {
	if (
		gitExecArgsRaw(
			["ls-files", "--unmerged", "-z"],
			repository,
			gitExecutionProcessConfiguration("prepared-merge"),
		)
	)
		throw new Error("Prepared merge index contains unresolved conflicts.");
	return createHash("sha256")
		.update(
			gitExecArgsRaw(
				["ls-files", "--stage", "-z"],
				repository,
				gitExecutionProcessConfiguration("prepared-merge"),
			),
		)
		.digest("hex");
}

/** Independent actual-object proof; graph overlays and plan metadata cannot replace parents. */
export function assertPreparedMergeCommit(
	repository: string,
	sha: string,
	witness: ValidatedSourceWitness,
): void {
	const merge = witness.preparedMerge;
	if (
		!merge ||
		sha !== merge.expectedCommitSha ||
		!witness.baseHeadSha ||
		!isFullGitObjectId(sha) ||
		readLocalObjectRevisions(
			repository,
			["--no-walk", sha],
			"prepared-merge",
		) !== sha
	)
		throw new Error("Missing exact prepared merge commit authority.");
	const raw = gitExecArgsRaw(
		["--no-replace-objects", "cat-file", "commit", sha],
		repository,
		gitExecutionProcessConfiguration("prepared-merge"),
	);
	const boundary = raw.indexOf("\n\n");
	const headers = raw.slice(0, boundary).split("\n");
	const parents = headers
		.filter((line) => line.startsWith("parent "))
		.map((line) => line.slice(7));
	if (
		boundary < 0 ||
		parents.length !== 2 ||
		parents[0] !== witness.baseHeadSha ||
		parents[1] !== merge.secondParentSha ||
		headers.filter((line) => line.startsWith("tree ")).join() !==
			`tree ${witness.expectedTreeSha}` ||
		raw.slice(boundary + 2) !== `${merge.message}\n`
	)
		throw new Error(
			"Actual merge commit does not match exact ordered parents, tree and frozen message.",
		);
}
