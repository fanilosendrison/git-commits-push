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
import { assertLocalCommitObject } from "../git/creation-local-objects.ts";
import { gitExecArgs } from "../git/git-exec.ts";
import type { InvocationRequest } from "./targeted-arguments.ts";

export type {
	InvocationRequest,
	ParsedInvocationArguments,
} from "./targeted-arguments.ts";
export { parseInvocationArguments } from "./targeted-arguments.ts";

const BRANCH_REF_PREFIX = "refs/heads/";

/**
 * Internal transport for the original invocation directory.
 *
 * The public launcher overwrites this key on every child environment from its
 * own `process.cwd()`, so an inherited or ambient value can never become
 * worktree-scope authority.
 */
export const GCP_INVOCATION_CWD_ENV = "GCP_INVOCATION_CWD";

type TargetedInvocationRequest = Exclude<
	InvocationRequest,
	{ kind: "worktree" }
>;
type WorktreeInvocationScope = Extract<InvocationScope, { kind: "worktree" }>;
type TargetedInvocationScope = Exclude<
	InvocationScope,
	{ kind: "global" | "worktree" }
>;

/** Legacy persisted-only scope. Never mutate this object. */
export const GLOBAL_INVOCATION_SCOPE: InvocationScope = Object.freeze({
	kind: "global",
});

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
	if (request.pushRemote === ".")
		throw new Error(
			"Targeted push remote must be a configured Git remote, not '.'.",
		);
	if (request.kind === "targeted-create") {
		if (
			!request.baseRef.startsWith(BRANCH_REF_PREFIX) ||
			request.baseRef === request.pushRef
		)
			throw new Error(
				"Creation requires distinct refs/heads/* source and destination refs.",
			);
		gitExecArgs(["check-ref-format", request.baseRef], canonicalRepository);
		assertLocalCommitObject(canonicalRepository, request.baseSha);
	}
	return Object.freeze({ ...request, repository: canonicalRepository });
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
 * Prove that a scope may authorize execution in the current runtime.
 *
 * Legacy `global` is structural compatibility state only: it may be parsed and
 * inspected, but it must never authorize discovery, supervisor, Turnlock, Git,
 * or LLM work. Fresh executable scopes are only `worktree` and `targeted`.
 */
export function assertExecutableInvocationScope(
	scope: InvocationScope,
): asserts scope is Exclude<InvocationScope, { readonly kind: "global" }> {
	if (scope.kind === "global") {
		throw new Error(
			"The legacy global invocation scope is non-executable in the current runtime; it may be parsed for compatibility but must be retired without replay.",
		);
	}
}

/**
 * Prove that a persisted scope still denotes the same invocation universe.
 * Never repairs or rewrites persisted state.
 *
 * A persisted `worktree` scope is immutable authority for its Turnlock run:
 * the exact persisted repository must still be a Git worktree root attached
 * to a symbolic branch. Revalidation never widens to siblings or search paths.
 * The `global` branch remains a structural no-op because compatibility and
 * executable authority are deliberately separate concerns.
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

	const resolved = resolveTargetedScope(scope);

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
