import {
	copyFileSync,
	lstatSync,
	mkdtempSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
	CommittedSha,
	OriginalHead,
	ValidatedSourceWitness,
} from "../../types.ts";
import { gitExecArgs, gitExecArgsRaw, gitExecIndexArgs } from "./git-exec.ts";
import { isFullGitObjectId } from "./git-object-id.ts";
import { readLocalObjectRevisions } from "./local-object-revisions.ts";

/** Completeness cannot be established; no retry may adopt a different source tree. */
export class PublicationCompletenessError extends Error {
	override name = "PublicationCompletenessError";
}

export function readOriginalHead(repository: string): OriginalHead {
	try {
		const sha = gitExecArgs(
			["--no-replace-objects", "rev-parse", "--verify", "HEAD"],
			repository,
		);
		if (readLocalObjectRevisions(repository, ["--no-walk", sha]) !== sha)
			throw new PublicationCompletenessError(
				"HEAD is not a direct local commit identity.",
			);
		return sha;
	} catch (error) {
		const symbolic = gitExecArgs(
			["symbolic-ref", "--quiet", "HEAD"],
			repository,
		);
		if (
			!gitExecArgs(
				["for-each-ref", "--format=%(objectname)", "--", symbolic],
				repository,
			)
		)
			return null;
		throw error;
	}
}

/** Ask Git for its own object-format-specific empty tree identity. */
export function readEmptyTree(repository: string): string {
	return gitExecArgs(["hash-object", "-t", "tree", "--stdin"], repository);
}

export function readHeadTree(repository: string): string {
	return gitExecArgs(
		["--no-replace-objects", "rev-parse", "HEAD^{tree}"],
		repository,
	);
}

/** Git paths are NUL-framed, literal, case-sensitive identities, not patch headers. */
export function changedPaths(
	repository: string,
	from: string | null,
	to: string,
): string[] {
	const raw = gitExecArgsRaw(
		[
			"--no-replace-objects",
			"diff-tree",
			"--no-commit-id",
			"--name-only",
			"--no-renames",
			"-r",
			"-z",
			from ?? readEmptyTree(repository),
			to,
			"--",
		],
		repository,
	);
	if (raw && !raw.endsWith("\0"))
		throw new PublicationCompletenessError(
			"Malformed Git changed-path output.",
		);
	return raw ? raw.slice(0, -1).split("\0") : [];
}

function identity(repository: string): {
	repository: string;
	gitDirectory: string;
} {
	return {
		repository: realpathSync(repository),
		gitDirectory: realpathSync(
			path.resolve(
				repository,
				gitExecArgs(["rev-parse", "--git-dir"], repository),
			),
		),
	};
}

export type IndexSourceSnapshot = Omit<
	ValidatedSourceWitness,
	"publicationRequired"
>;

/** Pin the index input before scanning; this alone grants no commit authority. */
export function readIndexSource(repository: string): IndexSourceSnapshot {
	const baseHeadSha = readOriginalHead(repository);
	const expectedTreeSha = readCurrentIndexTree(repository);
	return {
		...identity(repository),
		baseHeadSha,
		expectedTreeSha,
		expectedChangedPaths: changedPaths(
			repository,
			baseHeadSha,
			expectedTreeSha,
		),
	};
}

/** Capture only after staging and validation, before the first durable delegation. */
export function captureValidatedSource(
	repository: string,
	publicationRequired: boolean,
): ValidatedSourceWitness {
	return { ...readIndexSource(repository), publicationRequired };
}

/** write-tree may refresh cache-tree metadata; verification must not rewrite a raced index. */
function readCurrentIndexTree(repository: string): string {
	const directory = mkdtempSync(path.join(tmpdir(), "gcp-index-proof-"));
	const index = path.join(directory, "index");
	try {
		const source = gitExecArgs(
			["rev-parse", "--git-path", "index"],
			repository,
		);
		copyFileSync(path.resolve(repository, source), index);
		return gitExecIndexArgs(["write-tree"], repository, index).trim();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((p, i) => p === right[i]);
}

/** Compare working bytes against T using a private index; never reset/restage caller input. */
function assertWorkingTree(
	repository: string,
	tree: string,
	changed: readonly string[],
): void {
	const directory = mkdtempSync(path.join(tmpdir(), "gcp-source-proof-"));
	const index = path.join(directory, "index");
	try {
		gitExecIndexArgs(["read-tree", tree], repository, index);
		// Sparse checkout does not materialize unchanged base content. Preserve only
		// absent skip-worktree entries outside F; never hide a validated changed path
		// or a materialized file behind assume-unchanged/skip-worktree flags.
		const sparse = gitExecArgsRaw(["ls-files", "-t", "-z"], repository)
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
		);
		if (
			gitExecIndexArgs(
				["ls-files", "--others", "--exclude-standard", "-z"],
				repository,
				index,
			)
		)
			throw new Error("Unvalidated untracked paths.");
	} catch {
		throw new PublicationCompletenessError(
			"Worktree changed after validation; original complete tree is preserved as authority.",
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Re-establish source authority and actual landed membership without trusting plan metadata. */
export function assertValidatedSource(
	repository: string,
	witness: ValidatedSourceWitness | undefined,
	committed: readonly CommittedSha[] = [],
	publisherIndexTreeSha?: string,
): {
	witness: ValidatedSourceWitness;
	remainingPaths: string[];
	head: OriginalHead;
} {
	if (!witness)
		throw new PublicationCompletenessError(
			"Missing durable validated-source witness; historical state is diagnostic only.",
		);
	if (
		publisherIndexTreeSha !== undefined &&
		!isFullGitObjectId(publisherIndexTreeSha)
	)
		throw new PublicationCompletenessError(
			"Malformed publisher index progress identity.",
		);
	const currentIdentity = identity(repository);
	if (
		witness.repository !== currentIdentity.repository ||
		witness.gitDirectory !== currentIdentity.gitDirectory
	)
		throw new PublicationCompletenessError(
			"Validated-source witness belongs to a different worktree.",
		);
	try {
		if (
			readLocalObjectRevisions(repository, [
				"--quiet",
				"--objects",
				"--no-walk",
				witness.expectedTreeSha,
				...(witness.baseHeadSha ? [witness.baseHeadSha] : []),
			]) !== ""
		)
			throw new Error("Missing validated input objects.");
	} catch {
		throw new PublicationCompletenessError(
			"Validated source objects are unavailable locally; refusing automatic retrieval.",
		);
	}
	const expected = changedPaths(
		repository,
		witness.baseHeadSha,
		witness.expectedTreeSha,
	);
	if (!samePaths(expected, witness.expectedChangedPaths))
		throw new PublicationCompletenessError(
			"Validated changed-path membership is incoherent.",
		);
	const expectedSet = new Set(expected);
	let parent = witness.baseHeadSha;
	const accounted = new Set<string>();
	for (const commit of committed) {
		if (!isFullGitObjectId(commit.sha))
			throw new PublicationCompletenessError(
				"Malformed durable commit identity.",
			);
		const parents = readLocalObjectRevisions(repository, [
			"--parents",
			"--no-walk",
			commit.sha,
		]).split(" ");
		if (
			parents[0] !== commit.sha ||
			!samePaths(parents.slice(1), parent ? [parent] : [])
		)
			throw new PublicationCompletenessError(
				"Landed commit chain does not extend the validated HEAD exactly.",
			);
		const paths = changedPaths(repository, parent, commit.sha);
		const differing = new Set(
			changedPaths(repository, commit.sha, witness.expectedTreeSha),
		);
		const actualPaths = new Set(paths);
		if (
			commit.files.some(
				(file) => expectedSet.has(file) && !actualPaths.has(file),
			)
		)
			throw new PublicationCompletenessError(
				"Checkpointed ownership claims a validated path not changed by that commit.",
			);
		for (const file of paths) {
			if (
				!expectedSet.has(file) ||
				accounted.has(file) ||
				differing.has(file) ||
				!commit.files.includes(file)
			)
				throw new PublicationCompletenessError(
					"Landed commit contents do not match validated membership.",
				);
			accounted.add(file);
		}
		parent = commit.sha;
	}
	const head = readOriginalHead(repository);
	if (head !== parent)
		throw new PublicationCompletenessError(
			`HEAD changed or contains uncheckpointed commits: observed ${head ?? "UNBORN"}, checkpointed ${parent ?? "UNBORN"}; preserving history without replanning.`,
		);
	const remainingPaths = expected.filter((file) => !accounted.has(file));
	const index = readCurrentIndexTree(repository);
	if (index !== witness.expectedTreeSha) {
		const ownedIndex =
			publisherIndexTreeSha !== undefined && index === publisherIndexTreeSha;
		const staged =
			committed.length > 0 || ownedIndex
				? changedPaths(repository, head, index)
				: undefined;
		const differing = new Set(
			changedPaths(repository, index, witness.expectedTreeSha),
		);
		if (
			!staged ||
			(publisherIndexTreeSha !== undefined && !ownedIndex) ||
			staged.some(
				(file) => !remainingPaths.includes(file) || differing.has(file),
			)
		)
			throw new PublicationCompletenessError(
				"Index changed after validation; refusing to adopt residual input.",
			);
	}
	assertWorkingTree(
		repository,
		witness.expectedTreeSha,
		witness.expectedChangedPaths,
	);
	return {
		witness,
		remainingPaths,
		head,
	};
}

/** Remote identity alone is insufficient: prove the complete validated content first. */
export function assertFinalTree(
	repository: string,
	witness: ValidatedSourceWitness,
): string {
	const actual = readHeadTree(repository);
	if (actual !== witness.expectedTreeSha)
		throw new PublicationCompletenessError(
			`Final tree completeness not demonstrated: expected ${witness.expectedTreeSha}, actual ${actual}.`,
		);
	assertWorkingTree(
		repository,
		witness.expectedTreeSha,
		witness.expectedChangedPaths,
	);
	return actual;
}
