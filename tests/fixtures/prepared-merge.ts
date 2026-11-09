import assert from "node:assert/strict";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type { PreparedMergeScope } from "../../src/modules/git/prepared-merge-types.ts";
import { validatePreparedMerge } from "../../src/modules/git/prepared-merge-validation.ts";
import type { RepoState } from "../../src/types.ts";
import { GitRepoFixture } from "./git-repo.ts";
import { CREATE_SETTINGS, git } from "./targeted-create.ts";

/** Actual divergent histories, overlapping conflict and caller-approved resolved index. */
export function preparedMergeFixture(
	options: { candidateBytes?: string; resolutionBytes?: string } = {},
) {
	const repo = GitRepoFixture.create();
	const root = repo.dir;
	const write = (file: string, bytes: string) =>
		writeFileSync(path.join(root, file), bytes);
	const commit = (message: string) => {
		git(root, ["add", "-A"]);
		git(root, ["commit", "--no-verify", "-m", message]);
		return git(root, ["rev-parse", "HEAD"]);
	};
	write("overlap", "base\n");
	write("unrelated", "untouched\n");
	write("remove-me", "obsolete\n");
	write("rename-from", "rename bytes\n");
	const B = commit("test: establish common ancestor");
	write("overlap", "development\n");
	write("d-only", "development bytes\n");
	const D = commit("test: establish development history");
	git(root, ["checkout", "--detach", B]);
	write("overlap", "candidate\n");
	write("c-only", options.candidateBytes ?? "candidate bytes\n");
	const C = commit("test: establish candidate history");
	git(root, ["checkout", "--detach", D]);
	assert.throws(() => git(root, ["merge", "--no-ff", "--no-commit", C]));
	const conflictedIndex = readFileSync(
		path.resolve(root, git(root, ["rev-parse", "--git-path", "index"])),
	);
	write("overlap", options.resolutionBytes ?? "caller-approved resolution\n");
	unlinkSync(path.join(root, "remove-me"));
	renameSync(path.join(root, "rename-from"), path.join(root, "rename-to"));
	mkdirSync(path.join(root, "nested"));
	write("nested/new-file", "resolved new content\n");
	write(":literal [x]\t\n", "literal bytes\n");
	symlinkSync("d-only", path.join(root, "resolved-link"));
	git(root, ["add", "-A"]);
	// A parent gitlink belongs to T, without child-repository discovery/staging.
	git(root, [
		"update-index",
		"--add",
		"--cacheinfo",
		`160000,${C},resolved-gitlink`,
	]);
	// Existing completeness semantics expect the gitlink's worktree to be materialized.
	git(root, [
		"clone",
		"--no-hardlinks",
		root,
		path.join(root, "resolved-gitlink"),
	]);
	git(path.join(root, "resolved-gitlink"), ["checkout", "--detach", C]);
	const T = git(root, ["write-tree"]);
	const remote = path.join(root, ".git", "remote.git");
	git(root, ["init", "--bare", remote]);
	git(root, ["remote", "add", "origin", remote]);
	git(root, ["push", "origin", `${D}:refs/heads/destination`]);
	const scope: PreparedMergeScope = {
		kind: "prepared-merge",
		repository: root,
		pushRemote: "origin",
		pushRef: "refs/heads/destination",
		firstParent: D,
		secondParent: C,
		indexTree: T,
		mergeMessage: "feat(git): preserve caller-prepared merge provenance",
	};
	const args = [
		"--repository",
		root,
		"--push-remote",
		"origin",
		"--push-ref",
		scope.pushRef,
		"--publish-prepared-merge",
		"--first-parent",
		D,
		"--second-parent",
		C,
		"--index-tree",
		T,
		"--merge-message",
		scope.mergeMessage,
	];
	return {
		repo,
		root,
		B,
		D,
		C,
		T,
		remote,
		scope,
		args,
		write,
		commit,
		conflictedIndex,
		git: (args: string[]) => git(root, args),
		gitPath: (name: string) =>
			path.resolve(root, git(root, ["rev-parse", "--git-path", name])),
		async validated(): Promise<RepoState> {
			const { witness, target } = await validatePreparedMerge(
				scope,
				CREATE_SETTINGS,
			);
			return {
				repository: root,
				operation: "commit-and-push",
				status: "RUNNING",
				validatedSource: witness,
				explicitPushTargetSnapshot: target,
			};
		},
	};
}
export function assertTreeOracle(
	f: ReturnType<typeof preparedMergeFixture>,
	sha: string,
): void {
	const entry = (revision: string, file: string) =>
		f.git(["ls-tree", revision, "--", file]).split("\t")[0];
	assert.equal(entry(sha, "d-only"), entry(f.D, "d-only"));
	assert.equal(entry(sha, "c-only"), entry(f.C, "c-only"));
	assert.equal(entry(sha, "unrelated"), entry(f.B, "unrelated"));
	assert.equal(entry(sha, "overlap"), entry(f.T, "overlap"));
	assert.equal(f.git(["show", `${sha}:overlap`]), "caller-approved resolution");
	assert.equal(f.git(["rev-parse", `${sha}^{tree}`]), f.T);
}
