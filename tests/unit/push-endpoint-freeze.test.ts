import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { resolveSinglePushEndpoint } from "../../src/modules/git/push-endpoint.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("resolved endpoint ignores ambient rewrite changes during publication", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-endpoint-freeze-"));
	const resolvedRoot = path.join(root, "resolved");
	const replacementRoot = path.join(root, "replacement");
	const resolvedPath = path.join(resolvedRoot, "repo.git");
	const replacementPath = path.join(replacementRoot, "repo.git");
	fs.mkdirSync(resolvedRoot);
	fs.mkdirSync(replacementRoot);
	execFileSync("git", ["init", "--bare", resolvedPath]);
	execFileSync("git", ["init", "--bare", replacementPath]);
	const repository = GitRepoFixture.create();
	try {
		repository.commit("initial");
		const branch = git(repository.dir, [
			"symbolic-ref",
			"--quiet",
			"--short",
			"HEAD",
		]);
		const baseline = git(repository.dir, ["rev-parse", "HEAD"]);
		for (const remotePath of [resolvedPath, replacementPath]) {
			git(repository.dir, [
				"push",
				remotePath,
				`${baseline}:refs/heads/${branch}`,
			]);
		}
		repository.setRemote("origin", "gcp-freeze://repo.git");
		git(repository.dir, [
			"config",
			`url.${resolvedRoot}${path.sep}.insteadOf`,
			"gcp-freeze://",
		]);
		const endpoint = resolveSinglePushEndpoint(repository.dir, "origin");
		assert.strictEqual(
			endpoint.readDestinationSha(`refs/heads/${branch}`),
			baseline,
		);

		git(repository.dir, [
			"config",
			`url.${replacementRoot}${path.sep}.insteadOf`,
			`${resolvedRoot}${path.sep}`,
		]);
		repository.writeAndStage("ahead.ts", "export const ahead = true;\n");
		repository.commit("ahead");
		const head = git(repository.dir, ["rev-parse", "HEAD"]);
		endpoint.pushExact(head, `refs/heads/${branch}`, baseline);
		assert.strictEqual(git(resolvedPath, ["rev-parse", branch]), head);
		assert.strictEqual(git(replacementPath, ["rev-parse", branch]), baseline);
	} finally {
		repository.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
