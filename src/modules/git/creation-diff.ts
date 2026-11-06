import { createHash } from "node:crypto";
import type { RepoState } from "../../types.ts";
import { PushError } from "../core/errors.ts";
import { assertCreationDirtyInputsLocal } from "./creation-local-objects.ts";
import { assertExplicitCreateTargetCurrent } from "./explicit-create-target.ts";
import { gitExecArgs, gitExecArgsRaw } from "./git-exec.ts";

/** Creation scans and planning hashes use actual content, never ambient representations. */
export const CREATION_DIFF_ARGUMENTS = Object.freeze([
	"--text",
	"--full-index",
	"--no-color",
	"--no-ext-diff",
	"--no-textconv",
	"--no-renames",
	"--ignore-submodules=none",
	"--submodule=short",
	"--src-prefix=a/",
	"--dst-prefix=b/",
]);

function readCreationDiff(repository: string, args: readonly string[]): string {
	assertCreationDirtyInputsLocal(repository);
	return gitExecArgsRaw(
		[
			"--no-replace-objects",
			"--no-optional-locks",
			"diff",
			...args,
			...CREATION_DIFF_ARGUMENTS,
		],
		repository,
	);
}

/** Capture one canonical staged diff after proving its HEAD/index inputs are local. */
export function readCreationStagedDiff(repository: string): string {
	return readCreationDiff(repository, ["--cached", "--patch"]);
}

/** Preserve the existing planning cap's stat fallback without invoking ambient converters. */
export function readCreationStagedStat(repository: string): string {
	return readCreationDiff(repository, ["--cached", "--stat"]);
}

function changedRetryInput(): PushError {
	return new PushError(
		"Creation worktree or index changed after validation; refusing to replan unvalidated content.",
		false,
	);
}

/** Reuse only the same validated pre-commit input; never rebuild a changed authority. */
export function captureCreationRetryDiff(
	repo: RepoState,
	allowRestage: boolean,
	additionalCommittedCount = 0,
): string | undefined {
	const target = repo.explicitPushTargetSnapshot;
	if (!target || !("kind" in target)) return undefined;
	if (repo.committedShas?.length || additionalCommittedCount > 0)
		throw new PushError(
			"Creation commits are already present; replanning is forbidden.",
			false,
		);
	assertExplicitCreateTargetCurrent(repo.repository, target);
	const current = readCreationStagedDiff(repo.repository);
	const hash = (diff: string) =>
		createHash("sha256").update(diff).digest("hex");
	if (hash(current) === repo.diffHash) {
		if (
			readCreationDiff(repo.repository, ["--patch"]) ||
			gitExecArgsRaw(
				["--no-optional-locks", "ls-files", "--others", "--exclude-standard"],
				repo.repository,
			)
		)
			throw changedRetryInput();
		return current;
	}
	// Publisher cleanup may clear the index after a structural failure. Restore only
	// that empty index, and only if its complete raw content matches the old binding.
	if (current.trim() || !allowRestage) throw changedRetryInput();
	gitExecArgs(["add", "-A"], repo.repository);
	const restored = readCreationStagedDiff(repo.repository);
	if (hash(restored) !== repo.diffHash) throw changedRetryInput();
	return restored;
}
