import type { CommittedSha, OriginalHead } from "../../types.ts";

export type CommitPlanErrorKind =
	| "duplicate-file"
	| "empty-plans"
	| "incomplete-coverage"
	| "missing-file"
	| "nonexistent-file";

interface CommitPlanErrorContext {
	publisherIndexTreeSha?: string | undefined;
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
	publisherIndexTreeSha?: string | undefined;
	committedShas: CommittedSha[];
	originalHead: OriginalHead;
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
	readonly retryCount: number;

	constructor(message: string, transient: boolean, retryCount = 0) {
		super(message);
		this.transient = transient;
		this.retryCount = retryCount;
	}
}

/** Completeness cannot be established; no retry may adopt a different source tree. */
export class PublicationCompletenessError extends Error {
	override name = "PublicationCompletenessError";
}

/** Exact remote observation survives a later local-source refusal; it is not operation success. */
export class ObservedPublicationSourceError extends Error {
	override name = "ObservedPublicationSourceError";
	readonly publishedSha: string;
	constructor(publishedSha: string, sourceError: unknown) {
		super(
			`Local source refused after exact remote observation: ${sourceError instanceof Error ? sourceError.message : String(sourceError)}`,
			{ cause: sourceError },
		);
		this.publishedSha = publishedSha;
	}
}

export interface PostCommitPushErrorContext {
	readonly committedShas: CommittedSha[];
	readonly originalHead: OriginalHead;
	readonly pushRetryCount: number;
}

/** A push failed only after every planned commit was durably created locally. */
export class PostCommitPushError extends PushError {
	override name = "PostCommitPushError";
	readonly context: PostCommitPushErrorContext;

	constructor(pushError: PushError, context: PostCommitPushErrorContext) {
		super(pushError.message, pushError.transient, pushError.retryCount);
		this.context = context;
	}
}
