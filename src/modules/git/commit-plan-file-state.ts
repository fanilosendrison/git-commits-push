import { lstatSync } from "node:fs";
import * as path from "node:path";
import { gitExecArgsRaw } from "./git-exec.ts";

export interface CommitPlanFileState {
	readonly nonexistentFiles: readonly string[];
	readonly unchangedFiles: readonly string[];
}

function pathExists(filePath: string): boolean {
	try {
		lstatSync(filePath);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		throw error;
	}
}

/** Classify planned paths through stable Git plumbing, never localized stderr. */
export function inspectCommitPlanFileState(
	repositoryPath: string,
	plannedFiles: readonly string[],
): CommitPlanFileState {
	const nonexistentFiles: string[] = [];
	const unchangedFiles: string[] = [];
	for (const plannedFile of plannedFiles) {
		const status = gitExecArgsRaw(
			[
				"--literal-pathspecs",
				"status",
				"--porcelain=v1",
				"--ignored=matching",
				"-z",
				"--",
				plannedFile,
			],
			repositoryPath,
		);
		// Changed and ignored paths both defer to staging; ignored paths retain
		// their historical PartialCommitError classification.
		if (status.length > 0) continue;
		if (pathExists(path.resolve(repositoryPath, plannedFile))) {
			unchangedFiles.push(plannedFile);
			continue;
		}
		const trackedPath = gitExecArgsRaw(
			["--literal-pathspecs", "ls-files", "--cached", "-z", "--", plannedFile],
			repositoryPath,
		);
		if (trackedPath.length > 0) unchangedFiles.push(plannedFile);
		else nonexistentFiles.push(plannedFile);
	}
	return { nonexistentFiles, unchangedFiles };
}
