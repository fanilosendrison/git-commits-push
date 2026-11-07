import { PushError } from "../core/errors.ts";
import { gitExecArgs } from "./git-exec.ts";
import { isFullGitObjectId } from "./git-object-id.ts";
import { readLocalObjectRevisions } from "./local-object-revisions.ts";

function missingLocalObjects(): PushError {
	return new PushError(
		"Creation prerequisite missing: required local commit or patch objects are unavailable (no automatic fetch).",
		false,
	);
}

/** Git 2.17's --missing=print disables lazy fetch before revision parsing. */
export function readCreationLocalRevisions(
	repository: string,
	args: readonly string[],
): string {
	try {
		return readLocalObjectRevisions(repository, args);
	} catch {
		throw missingLocalObjects();
	}
}

/** Require a direct, locally present commit OID, not a revision expression or peeled tag. */
export function assertLocalCommitObject(repository: string, sha: string): void {
	if (!isFullGitObjectId(sha))
		throw new PushError(
			"Creation base requires a full nonzero commit object ID.",
			false,
		);
	const head = gitExecArgs(["rev-parse", "--verify", "HEAD"], repository);
	if (head.length !== sha.length) throw missingLocalObjects();
	// A tag prints its peeled commit rather than its own OID; a non-commit cannot
	// produce this exact one-commit result. Unlike cat-file, this cannot lazy fetch.
	if (readCreationLocalRevisions(repository, ["--no-walk", sha]) !== sha)
		throw missingLocalObjects();
}

/** Prove B <= descendant from Git's exact ancestry boundary without fetching objects. */
export function assertCreationAncestry(
	repository: string,
	baseSha: string,
	descendantSha: string,
): void {
	assertLocalCommitObject(repository, baseSha);
	if (baseSha === descendantSha) return;
	assertLocalCommitObject(repository, descendantSha);
	const entries = readCreationLocalRevisions(repository, [
		"--ancestry-path",
		"--boundary",
		`${baseSha}..${descendantSha}`,
	])
		.split("\n")
		.filter(Boolean);
	if (
		entries.some(
			(entry) =>
				!isFullGitObjectId(entry.startsWith("-") ? entry.slice(1) : entry),
		)
	)
		throw missingLocalObjects();
	if (entries.includes(`-${baseSha}`)) return;
	if (
		gitExecArgs(["rev-parse", "--is-shallow-repository"], repository) === "true"
	)
		throw missingLocalObjects();
	throw new PushError(
		"Creation base is not an ancestor of the observed source or worktree HEAD.",
		false,
	);
}

/** Qualify only this worktree's HEAD/index before staging or reading a dirty diff. */
export function assertCreationDirtyInputsLocal(repository: string): void {
	const head = gitExecArgs(["rev-parse", "--verify", "HEAD"], repository);
	assertLocalCommitObject(repository, head);
	// --indexed-objects otherwise inspects every linked worktree. This explicit
	// selector preserves the exact invocation scope and never reads a sibling index.
	if (
		readCreationLocalRevisions(repository, [
			"--quiet",
			"--objects",
			"--no-walk",
			"--single-worktree",
			"--indexed-objects",
			head,
		]) !== ""
	)
		throw missingLocalObjects();
}

/** Materialize only local patch input trees (each outgoing commit and its parents). */
export function assertCreationPatchObjectsLocal(
	repository: string,
	outgoingShas: readonly string[],
): void {
	for (const sha of outgoingShas) {
		if (!isFullGitObjectId(sha)) throw missingLocalObjects();
		const roots = readCreationLocalRevisions(repository, [
			"--no-walk",
			"--parents",
			sha,
		]).split(/\s+/u);
		if (roots[0] !== sha || roots.some((root) => !isFullGitObjectId(root)))
			throw missingLocalObjects();
		// --quiet suppresses ordinary object/path output, but --missing=print still
		// emits ?OID records. No earlier commit content is audited or fetched.
		if (
			readCreationLocalRevisions(repository, [
				"--quiet",
				"--objects",
				"--no-walk",
				...roots,
			]) !== ""
		)
			throw missingLocalObjects();
	}
}
