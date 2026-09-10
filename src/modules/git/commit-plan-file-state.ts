import * as path from "node:path";
import { gitExecArgs } from "./git-exec.ts";

export interface CommitPlanFileState {
	readonly nonexistentFiles: readonly string[];
	readonly unchangedFiles: readonly string[];
}

function splitNullTerminated(output: string): string[] {
	return output.split("\0").filter(Boolean);
}

function normalizeRepositoryPath(filePath: string): string {
	return path.posix.normalize(filePath).replace(/^\.\//u, "");
}

/** Classify planned paths through stable Git plumbing, never localized stderr. */
export function inspectCommitPlanFileState(
	repositoryPath: string,
	plannedFiles: readonly string[],
): CommitPlanFileState {
	const nonexistentFiles: string[] = [];
	const unchangedFiles: string[] = [];
	for (const plannedFile of plannedFiles) {
		const normalized = normalizeRepositoryPath(plannedFile);
		const knownPaths = splitNullTerminated(
			gitExecArgs(
				[
					"ls-files",
					"--cached",
					"--others",
					"--exclude-standard",
					"-z",
					"--",
					plannedFile,
				],
				repositoryPath,
			),
		).map(normalizeRepositoryPath);
		if (!knownPaths.includes(normalized)) {
			nonexistentFiles.push(plannedFile);
			continue;
		}
		const status = gitExecArgs(
			["status", "--porcelain=v1", "-z", "--", plannedFile],
			repositoryPath,
		);
		if (status.length === 0) unchangedFiles.push(plannedFile);
	}
	return { nonexistentFiles, unchangedFiles };
}
