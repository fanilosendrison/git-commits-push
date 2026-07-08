import type { CommittedSha } from "../../types.ts";

export type CommitPlanErrorKind =
	| "duplicate-file"
	| "empty-plans"
	| "missing-file"
	| "nonexistent-file";

export class CommitPlanError extends Error {
	override name = "CommitPlanError";

	constructor(
		message: string,
		public readonly kind: CommitPlanErrorKind,
		public readonly files?: string[],
		public readonly context?: {
			committedShas?: CommittedSha[];
			pendingFiles?: string[];
		},
	) {
		super(message);
	}
}

export class DiffHashMismatchError extends Error {
	override name = "DiffHashMismatchError";

	constructor() {
		super("DiffHash mismatch: The staged diff changed during LLM inference.");
	}
}

export class GitExecError extends Error {
	override name = "GitExecError";

	constructor(
		message: string,
		public readonly command: string,
		public readonly exitCode: number,
	) {
		super(message);
	}
}

export class PartialCommitError extends Error {
	override name = "PartialCommitError";

	constructor(
		message: string,
		public readonly context: {
			committedShas: CommittedSha[];
			originalHead: string;
			failedIndex: number;
			totalCount: number;
			pendingFiles: string[];
		},
	) {
		super(message);
	}
}

export class PushError extends Error {
	override name = "PushError";

	constructor(
		message: string,
		public readonly transient: boolean,
	) {
		super(message);
	}
}
