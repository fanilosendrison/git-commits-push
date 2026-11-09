import { copyFileSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PublicationCompletenessError } from "../core/errors.ts";
import {
	type GitExecutionPolicy,
	gitExecArgs,
	gitExecArgsRaw,
	gitExecIndexArgs,
	gitExecutionProcessConfiguration,
} from "./git-exec.ts";

/** write-tree may refresh cache metadata; inspect a copy without rewriting a raced caller index. */
export function readCurrentIndexTree(
	repository: string,
	executionPolicy: GitExecutionPolicy,
): string {
	const directory = mkdtempSync(path.join(tmpdir(), "gcp-index-proof-"));
	const index = path.join(directory, "index");
	try {
		const source = gitExecArgs(
			["rev-parse", "--git-path", "index"],
			repository,
			gitExecutionProcessConfiguration(executionPolicy),
		);
		copyFileSync(path.resolve(repository, source), index);
		return gitExecIndexArgs(
			["write-tree"],
			repository,
			index,
			undefined,
			executionPolicy,
		).trim();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Keep T as the private comparison authority; never permit index-writing hooks to replace it. */
export function assertWorkingTree(
	repository: string,
	tree: string,
	changed: readonly string[],
	executionPolicy: GitExecutionPolicy,
): void {
	const directory = mkdtempSync(path.join(tmpdir(), "gcp-source-proof-"));
	const index = path.join(directory, "index");
	try {
		gitExecIndexArgs(
			["read-tree", tree],
			repository,
			index,
			undefined,
			executionPolicy,
		);
		// Preserve only absent unchanged sparse companions; never hide a validated changed path.
		const sparse = gitExecArgsRaw(
			["ls-files", "-t", "-z"],
			repository,
			gitExecutionProcessConfiguration(executionPolicy),
		)
			.split("\0")
			.filter((record) => record.startsWith("S "))
			.map((record) => record.slice(2))
			.filter((file) => {
				if (changed.includes(file)) return false;
				try {
					lstatSync(path.join(repository, file));
					return false;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
					throw error;
				}
			});
		if (sparse.length)
			gitExecIndexArgs(
				["update-index", "--skip-worktree", "-z", "--stdin"],
				repository,
				index,
				`${sparse.join("\0")}\0`,
				executionPolicy,
			);
		gitExecIndexArgs(
			[
				"diff",
				"--quiet",
				"--no-ext-diff",
				"--no-textconv",
				"--ignore-submodules=dirty",
				"--",
			],
			repository,
			index,
			undefined,
			executionPolicy,
		);
		if (
			gitExecIndexArgs(
				["ls-files", "--others", "--exclude-standard", "-z"],
				repository,
				index,
				undefined,
				executionPolicy,
			)
		)
			throw new Error("Unvalidated untracked paths.");
		if (
			executionPolicy === "prepared-merge" &&
			gitExecIndexArgs(
				["write-tree"],
				repository,
				index,
				undefined,
				executionPolicy,
			).trim() !== tree
		)
			throw new Error(
				"Private comparison index no longer equals the original validated tree.",
			);
	} catch {
		throw new PublicationCompletenessError(
			"Worktree changed after validation; original complete tree is preserved as authority.",
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
