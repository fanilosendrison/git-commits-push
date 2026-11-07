import path from "node:path";
import type { CommitPlan } from "../../types.ts";
import { CommitPlanError } from "../core/errors.ts";
import { inspectCommitPlanFileState } from "./commit-plan-file-state.ts";

/** Admit only exact file membership; directory/pathspec expansion never proves coverage. */
export function assertCommitPlanCoverage(
	repository: string,
	plans: readonly CommitPlan[],
	remaining: readonly string[],
	validatedPaths: readonly string[],
): void {
	if (!plans.length)
		throw new CommitPlanError(
			"No complete commit plan was supplied.",
			"empty-plans",
		);
	const expected = new Set(remaining);
	const seen = new Set<string>();
	const aliases = new Set<string>();
	for (const plan of plans) {
		for (const file of plan.files) {
			const alias = path.posix.normalize(file).replace(/\/+$/, "");
			if (aliases.has(alias))
				throw new CommitPlanError(
					`File ${JSON.stringify(file)} appears in multiple plans; use a single Fat Commit.`,
					"duplicate-file",
					[file],
				);
			aliases.add(alias);
		}
	}
	for (const plan of plans) {
		for (const file of plan.files) {
			if (
				!file ||
				file.startsWith("/") ||
				file
					.split("/")
					.some((part) => part === "." || part === ".." || !part) ||
				file.includes("\0")
			)
				throw new CommitPlanError(
					`Non-canonical literal Git path: ${JSON.stringify(file)}.`,
					"nonexistent-file",
					[file],
				);
			seen.add(file);
		}
	}
	const repeated = [...seen].filter(
		(file) => validatedPaths.includes(file) && !expected.has(file),
	);
	if (repeated.length)
		throw new CommitPlanError(
			"Plan reclaims validated paths already established by prior commits.",
			"duplicate-file",
			repeated,
		);
	const nonexistent = inspectCommitPlanFileState(repository, [
		...seen,
	]).nonexistentFiles;
	if (nonexistent.length)
		throw new CommitPlanError(
			"Plan references nonexistent paths.",
			"nonexistent-file",
			[...nonexistent],
		);
	const missing = remaining.filter((file) => !seen.has(file));
	if (missing.length)
		throw new CommitPlanError(
			`Incomplete commit plan; missing paths: ${missing.map((file) => JSON.stringify(file)).join(", ")}.`,
			"incomplete-coverage",
			missing,
		);
	for (const plan of plans) {
		// Historical unchanged-file companions are tolerated, but cannot stand in for
		// a missing expected path or authorize a directory's implicit descendants.
		const extras = plan.files.filter((file) => !expected.has(file));
		const state = inspectCommitPlanFileState(repository, extras);
		if (extras.some((file) => !state.unchangedFiles.includes(file)))
			throw new CommitPlanError(
				"Plan includes paths outside validated remaining membership.",
				"nonexistent-file",
				extras,
			);
		if (!plan.files.some((file) => expected.has(file)))
			throw new CommitPlanError(
				"Plan has no remaining validated changes.",
				"missing-file",
				plan.files,
			);
	}
}
