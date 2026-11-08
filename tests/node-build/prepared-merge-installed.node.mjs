import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import {
	assertTreeOracle,
	preparedMergeFixture,
} from "../fixtures/prepared-merge.ts";
import {
	installCreateQualification,
	withCreateFixture,
} from "./fixtures/create-installed-qualification.mjs";
import { runGit, waitForClose } from "./fixtures/reconciler-e2e-helpers.mjs";

let installed;
before(async () => {
	installed = await installCreateQualification();
});
after(async () => {
	await installed?.cleanup();
});

for (const mode of ["installed", "compiled"])
	test(`${mode} public launcher consumes resolved merge without inference, source or pnpm`, async () => {
		await withCreateFixture(installed, async (envFixture) => {
			const f = preparedMergeFixture();
			try {
				const env = { ...envFixture.env };
				delete env.NODE_OPTIONS;
				delete env.OPENAI_API_KEY;
				assert.notEqual(spawnSync("pnpm", ["--version"], { env }).status, 0);
				assert.equal(
					existsSync(
						path.join(
							path.dirname(installed.releaseDirectory),
							"deployment-source",
						),
					),
					false,
				);
				const config = f.git(["config", "--local", "--list"]);
				const command =
					mode === "installed"
						? installed.paths.publicExecutablePath
						: process.execPath;
				const args =
					mode === "installed"
						? f.args
						: [
								path.resolve(
									import.meta.dirname,
									"../../bin/git-commits-push.mjs",
								),
								...f.args,
							];
				const child = spawn(command, args, {
					cwd: env.HOME,
					env,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let output = "";
				child.stdout.on("data", (d) => {
					output += d.toString();
				});
				child.stderr.on("data", (d) => {
					output += d.toString();
				});
				assert.equal(await waitForClose(child), 0, output);
				const M = f.git(["rev-parse", "HEAD"]);
				assert.equal(f.git(["show", "-s", "--format=%P", M]), `${f.D} ${f.C}`);
				assertTreeOracle(f, M);
				assert.equal(
					f.git(["rev-list", "--first-parent", "--count", `${f.D}..HEAD`]),
					"1",
				);
				assert.equal(runGit(f.remote, ["rev-parse", f.scope.pushRef], env), M);
				assert.equal(
					runGit(f.remote, ["for-each-ref", "--format=%(refname)"], env),
					f.scope.pushRef,
				);
				assert.equal(f.git(["status", "--porcelain"]), "");
				assert.equal(existsSync(f.gitPath("MERGE_HEAD")), false);
				assert.equal(f.git(["config", "--local", "--list"]), config);
				assert.equal(existsSync(env.MOCK_LLM_REQUEST_LOG), false);
				const runs = await readdir(
					path.join(env.TURNLOCK_RUN_DIR_ROOT, "git-commits-push-tl"),
				);
				assert.equal(runs.length, 1);
				const state = JSON.parse(
					await readFile(
						path.join(
							env.TURNLOCK_RUN_DIR_ROOT,
							"git-commits-push-tl",
							runs[0],
							"state.json",
						),
						"utf8",
					),
				);
				assert.deepEqual(state.data.invocationScope, f.scope);
				const repo = Object.values(state.data.repos)[0];
				assert.equal(repo.status, "SUCCESS");
				assert.equal(repo.publishedSha, M);
				assert.equal(repo.validatedSource.expectedTreeSha, f.T);
				assert.equal(repo.validatedSource.preparedMerge.secondParentSha, f.C);
				assert.equal(repo.committedShas.length, 1);
				assert.equal(repo.commitCompletion.finalHeadSha, M);
			} finally {
				f.repo.dispose();
			}
		});
	});
