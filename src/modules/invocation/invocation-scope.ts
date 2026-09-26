/**
 * src/modules/invocation/invocation-scope.ts — Single authority for the
 * targeted CLI argument group, canonical scope resolution, and persisted
 * scope revalidation.
 *
 * The parser is intentionally pure: it performs no filesystem access and no
 * Git subprocess work, so reconciliation admission (Issue #8) can reuse it to
 * classify an invocation before any Git execution. Filesystem and Git
 * validation live in the separate resolution step.
 *
 * An ordinary invocation (no owned flags) resolves through the worktree
 * resolver against the original invocation directory transported in
 * `GCP_INVOCATION_CWD_ENV`. That directory is internal transport written by the
 * public launcher from its real `process.cwd()`; it is never user authority.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { InvocationScope } from "../../types.ts";
import { gitExecArgs } from "../git/git-exec.ts";

const OWNED_FLAGS = ["--repository", "--push-remote", "--push-ref"] as const;
type OwnedFlag = (typeof OWNED_FLAGS)[number];

const BRANCH_REF_PREFIX = "refs/heads/";

/**
 * Internal transport for the original invocation directory.
 *
 * The public launcher overwrites this key on every child environment from its
 * own `process.cwd()`, so an inherited or ambient value can never become
 * worktree-scope authority.
 */
export const GCP_INVOCATION_CWD_ENV = "GCP_INVOCATION_CWD";

/** Uncanonicalized invocation request derived from argv. */
export type InvocationRequest =
	| {
			readonly kind: "worktree";
	  }
	| {
			readonly kind: "targeted";
			readonly repository: string;
			readonly pushRemote: string;
			readonly pushRef: string;
	  };

export interface ParsedInvocationArguments {
	readonly request: InvocationRequest;
	readonly passthroughArguments: readonly string[];
}

type TargetedInvocationRequest = Extract<
	InvocationRequest,
	{ kind: "targeted" }
>;

type WorktreeInvocationScope = Extract<InvocationScope, { kind: "worktree" }>;
type TargetedInvocationScope = Extract<InvocationScope, { kind: "targeted" }>;

const WORKTREE_INVOCATION_REQUEST: InvocationRequest = Object.freeze({
	kind: "worktree",
});

/** Legacy persisted-only scope. Never mutate this object. */
export const GLOBAL_INVOCATION_SCOPE: InvocationScope = Object.freeze({
	kind: "global",
});

function isOwnedFlag(value: string): value is OwnedFlag {
	return (OWNED_FLAGS as readonly string[]).includes(value);
}

function matchesOwnedEqualsSyntax(value: string): boolean {
	return OWNED_FLAGS.some((flag) => value.startsWith(`${flag}=`));
}

/**
 * Parse the atomic targeted argument group out of an argument vector.
 *
 * Owned flags are `--repository`, `--push-remote`, and `--push-ref`. Every
 * other argument is preserved byte-for-byte in original order so Turnlock
 * (`--run-id`, `--resume`, and future flags) keeps seeing exactly what the
 * caller supplied. No owned flag means an ordinary worktree request.
 */
export function parseInvocationArguments(
	args: readonly string[],
): ParsedInvocationArguments {
	const passthroughArguments: string[] = [];
	const ownedValues = new Map<OwnedFlag, string>();

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === undefined) continue;

		if (matchesOwnedEqualsSyntax(argument)) {
			throw new Error(
				`Targeted invocation flag "${argument}" does not accept --flag=value syntax; supply the flag and value as separate arguments.`,
			);
		}

		if (!isOwnedFlag(argument)) {
			passthroughArguments.push(argument);
			continue;
		}

		if (ownedValues.has(argument)) {
			throw new Error(`Duplicate targeted invocation flag: ${argument}.`);
		}

		const value = args[index + 1];
		if (value === undefined || value.startsWith("--")) {
			throw new Error(
				`Targeted invocation flag ${argument} requires exactly one value.`,
			);
		}

		ownedValues.set(argument, value);
		index += 1;
	}

	const presentFlags = OWNED_FLAGS.filter((flag) => ownedValues.has(flag));

	if (presentFlags.length === 0) {
		return {
			request: WORKTREE_INVOCATION_REQUEST,
			passthroughArguments,
		};
	}

	if (presentFlags.length !== OWNED_FLAGS.length) {
		throw new Error(
			"Targeted invocation requires all three flags together: --repository, --push-remote, and --push-ref.",
		);
	}

	if (args.includes("--resume")) {
		throw new Error(
			"targeted invocation arguments cannot be supplied with --resume; resume uses the persisted invocation scope",
		);
	}

	const repository = ownedValues.get("--repository");
	const pushRemote = ownedValues.get("--push-remote");
	const pushRef = ownedValues.get("--push-ref");
	if (
		repository === undefined ||
		pushRemote === undefined ||
		pushRef === undefined
	) {
		throw new Error(
			"Targeted invocation requires all three flags together: --repository, --push-remote, and --push-ref.",
		);
	}

	return {
		request: {
			kind: "targeted",
			repository,
			pushRemote,
			pushRef,
		},
		passthroughArguments,
	};
}

function resolveTargetedScope(
	request: TargetedInvocationRequest,
): TargetedInvocationScope {
	if (!path.isAbsolute(request.repository)) {
		throw new Error(
			`Targeted repository must be an absolute path: ${request.repository}.`,
		);
	}

	let canonicalRepository: string;
	try {
		canonicalRepository = fs.realpathSync(request.repository);
	} catch {
		throw new Error(
			`Targeted repository does not exist or cannot be resolved: ${request.repository}.`,
		);
	}

	const repositoryStats = fs.statSync(canonicalRepository);
	if (!repositoryStats.isDirectory()) {
		throw new Error(
			`Targeted repository must be a directory: ${canonicalRepository}.`,
		);
	}

	const topLevel = gitExecArgs(
		["rev-parse", "--show-toplevel"],
		canonicalRepository,
	);
	let canonicalTopLevel: string;
	try {
		canonicalTopLevel = fs.realpathSync(topLevel);
	} catch {
		throw new Error(
			`Targeted repository Git top-level cannot be resolved: ${topLevel}.`,
		);
	}

	if (canonicalTopLevel !== canonicalRepository) {
		throw new Error(
			`Targeted repository must be the exact Git worktree root: requested ${canonicalRepository}, Git top-level is ${canonicalTopLevel}.`,
		);
	}

	const remotes = gitExecArgs(["remote"], canonicalRepository)
		.split("\n")
		.map((value) => value.trim())
		.filter(Boolean);
	if (!remotes.includes(request.pushRemote)) {
		throw new Error(
			`Targeted push remote "${request.pushRemote}" is not a configured Git remote in ${canonicalRepository}.`,
		);
	}

	if (
		!request.pushRef.startsWith(BRANCH_REF_PREFIX) ||
		request.pushRef.length === BRANCH_REF_PREFIX.length
	) {
		throw new Error(
			`Targeted push ref must be a fully qualified refs/heads/* branch ref: ${request.pushRef}.`,
		);
	}

	gitExecArgs(["check-ref-format", request.pushRef], canonicalRepository);

	return Object.freeze({
		kind: "targeted",
		repository: canonicalRepository,
		pushRemote: request.pushRemote,
		pushRef: request.pushRef,
	});
}

function readAttachedBranch(repository: string): string | null {
	try {
		const branch = gitExecArgs(
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			repository,
		);
		return branch || null;
	} catch {
		return null;
	}
}

/**
 * Canonicalize the original invocation directory into the exact Git worktree
 * that contains it. A nested directory is valid; the repository directory is
 * not required to equal the invocation directory.
 */
function resolveWorktreeScope(
	invocationDirectory: string | undefined,
): WorktreeInvocationScope {
	if (invocationDirectory === undefined || invocationDirectory.length === 0) {
		throw new Error(
			"internal contract violation: resolving an ordinary worktree invocation requires the transported original invocation directory",
		);
	}

	let canonicalInvocationDirectory: string;
	try {
		canonicalInvocationDirectory = fs.realpathSync(invocationDirectory);
	} catch {
		throw new Error(
			`Ordinary invocation directory does not exist or cannot be resolved: ${invocationDirectory}.`,
		);
	}

	const invocationStats = fs.statSync(canonicalInvocationDirectory);
	if (!invocationStats.isDirectory()) {
		throw new Error(
			`Ordinary invocation directory must be a directory: ${canonicalInvocationDirectory}.`,
		);
	}

	let rawTopLevel: string;
	try {
		rawTopLevel = gitExecArgs(
			["rev-parse", "--show-toplevel"],
			canonicalInvocationDirectory,
		);
	} catch {
		throw new Error(
			`Ordinary invocation directory is not inside a Git worktree: ${canonicalInvocationDirectory}.`,
		);
	}

	let canonicalTopLevel: string;
	try {
		canonicalTopLevel = fs.realpathSync(rawTopLevel);
	} catch {
		throw new Error(
			`Ordinary invocation Git top-level cannot be resolved: ${rawTopLevel}.`,
		);
	}

	if (readAttachedBranch(canonicalTopLevel) === null) {
		throw new Error(
			`Ordinary invocation worktree is on a detached HEAD: ${canonicalTopLevel}. ` +
				"An ordinary invocation has no implicit publication destination; use explicit targeted publication with --repository, --push-remote, and --push-ref to publish a detached worktree.",
		);
	}

	return Object.freeze({
		kind: "worktree",
		repository: canonicalTopLevel,
	});
}

/**
 * Canonicalize a parsed invocation request into its durable scope.
 *
 * `invocationDirectory` is the trusted internal transport for a `worktree`
 * request only. Explicit targeted requests resolve from their own absolute
 * `--repository` argument and ignore it.
 */
export function resolveInvocationScope(
	request: InvocationRequest,
	invocationDirectory?: string,
): InvocationScope {
	if (request.kind === "worktree") {
		return resolveWorktreeScope(invocationDirectory);
	}
	return resolveTargetedScope(request);
}

/**
 * Prove that a persisted scope still denotes the same invocation universe.
 * Never repairs or rewrites persisted state.
 *
 * A persisted `worktree` scope is immutable authority for its Turnlock run:
 * the exact persisted repository must still be a Git worktree root attached
 * to a symbolic branch. Revalidation never widens to siblings or search paths.
 */
export function assertInvocationScopeCurrent(scope: InvocationScope): void {
	if (scope.kind === "global") {
		return;
	}

	if (scope.kind === "worktree") {
		const resolved = resolveWorktreeScope(scope.repository);
		if (resolved.repository !== scope.repository) {
			throw new Error(
				"Persisted worktree invocation scope no longer matches the current worktree.",
			);
		}
		return;
	}

	const resolved = resolveTargetedScope({
		kind: "targeted",
		repository: scope.repository,
		pushRemote: scope.pushRemote,
		pushRef: scope.pushRef,
	});

	if (
		resolved.repository !== scope.repository ||
		resolved.pushRemote !== scope.pushRemote ||
		resolved.pushRef !== scope.pushRef
	) {
		throw new Error(
			"Persisted targeted invocation scope no longer matches the current worktree, remote, or ref.",
		);
	}
}
