import type { CommittedSha } from "../../types.ts";

export type CommitPlanErrorKind =
	| "duplicate-file"
	| "empty-plans"
	| "missing-file"
	| "nonexistent-file";

interface CommitPlanErrorContext {
	committedShas?: CommittedSha[];
	pendingFiles?: string[];
}

export class CommitPlanError extends Error {
	override name = "CommitPlanError";
	readonly kind: CommitPlanErrorKind;
	readonly files: string[] | undefined;
	readonly context: CommitPlanErrorContext | undefined;

	constructor(
		message: string,
		kind: CommitPlanErrorKind,
		files?: string[],
		context?: CommitPlanErrorContext,
	) {
		super(message);
		this.kind = kind;
		this.files = files;
		this.context = context;
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
	readonly command: string;
	readonly exitCode: number;

	constructor(message: string, command: string, exitCode: number) {
		super(message);
		this.command = command;
		this.exitCode = exitCode;
	}
}

interface PartialCommitErrorContext {
	committedShas: CommittedSha[];
	originalHead: string;
	failedIndex: number;
	totalCount: number;
	pendingFiles: string[];
}

export class PartialCommitError extends Error {
	override name = "PartialCommitError";
	readonly context: PartialCommitErrorContext;

	constructor(message: string, context: PartialCommitErrorContext) {
		super(message);
		this.context = context;
	}
}

export class PushError extends Error {
	override name = "PushError";
	readonly transient: boolean;

	constructor(message: string, transient: boolean) {
		super(message);
		this.transient = transient;
	}
}
