import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	parseInvocationArguments,
	resolveInvocationScope,
} from "../../src/modules/invocation/invocation-scope.ts";
import type { Settings } from "../../src/types.ts";
import { GitRepoFixture } from "./git-repo.ts";

export const CREATE_SETTINGS: Settings = {
	searchPaths: [],
	provider: "openai",
	model: "unused",
	temperature: 0,
	systemPromptPath: "/dev/null",
	autoPush: false,
	skipTests: true,
};
export function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: "pipe",
	}).trim();
}
/** Real isolated bare endpoint and detached worktree with an observable source. */
export function createFixture() {
	const repo = GitRepoFixture.create();
	repo.commit("base");
	const remote = path.join(repo.dir, ".git", "remote.git");
	git(repo.dir, ["init", "--bare", remote]);
	git(repo.dir, ["remote", "add", "origin", remote]);
	const baseSha = git(repo.dir, ["rev-parse", "HEAD"]);
	git(repo.dir, ["push", "origin", "HEAD:refs/heads/source"]);
	repo.checkoutDetached();
	const args = [
		"--repository",
		repo.dir,
		"--push-remote",
		"origin",
		"--push-ref",
		"refs/heads/task",
		"--create-if-absent",
		"--base-ref",
		"refs/heads/source",
		"--base-sha",
		baseSha,
	];
	return {
		repo,
		remote,
		baseSha,
		args,
		scope: () => resolveInvocationScope(parseInvocationArguments(args).request),
		commit(file = "work.txt", content = "work\n") {
			fs.writeFileSync(path.join(repo.dir, file), content);
			git(repo.dir, ["add", file]);
			git(repo.dir, ["commit", "--no-verify", "-m", "feat: work"]);
			return git(repo.dir, ["rev-parse", "HEAD"]);
		},
	};
}
