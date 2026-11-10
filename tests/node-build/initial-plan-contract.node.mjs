import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
	installCreateQualification,
	startInstalled,
	withCreateFixture,
} from "./fixtures/create-installed-qualification.mjs";
import { runGit } from "./fixtures/reconciler-e2e-helpers.mjs";

const preload = pathToFileURL(
	path.join(import.meta.dirname, "fixtures/mock-completeness-fetch.mjs"),
).href;
const files = ["one.ts", "two.ts", "three.ts", "four.ts"];
const valid = files.map((file) => ({
	commit: {
		type: "test",
		description: "verify initial plan contracts",
		isBreaking: false,
	},
	files: [file],
}));
let candidate;
before(async () => {
	candidate = await installCreateQualification();
});
after(async () => {
	await candidate?.cleanup();
});

for (const scenario of [
	"one-missing",
	"all-missing",
	"malformed",
	"complete",
	"complete-second",
]) {
	test(`installed targeted publisher: ${scenario} preserves schema, bounds and exact Git content`, async () => {
		await withCreateFixture(candidate, async (f) => {
			for (const file of files)
				await writeFile(
					path.join(f.worktree, file),
					"safe synthetic fixture\n",
				);
			runGit(f.worktree, ["add", "-A"], f.env);
			const T = runGit(f.worktree, ["write-tree"], f.env);
			const missing = valid.map(({ commit, files: owned }, index) => ({
				commit:
					scenario === "one-missing" && index !== 2
						? commit
						: {
								type: commit.type,
								body: "This body is not a description",
								isBreaking: false,
							},
				files: owned,
			}));
			const success = scenario === "complete" || scenario === "complete-second";
			const batches =
				scenario === "complete"
					? [valid]
					: scenario === "complete-second"
						? [missing, valid]
						: [scenario === "malformed" ? "not a plan" : missing];
			const args = [
				"--repository",
				f.worktree,
				"--push-remote",
				"origin",
				"--push-ref",
				f.baseRef,
			];
			const invocation = startInstalled(candidate, f, args, {
				NODE_OPTIONS: `--import=${preload}`,
				GCP_COMPLETENESS_PLANS: JSON.stringify(batches),
			});
			const outcome = await invocation.done();
			const requests = (await readFile(f.env.MOCK_LLM_REQUEST_LOG, "utf8"))
				.trim()
				.split("\n");
			assert.equal(requests.length, scenario === "complete" ? 1 : 2);
			if (success) {
				assert.equal(outcome.code, 0, outcome.output);
				const H = runGit(f.worktree, ["rev-parse", "HEAD"], f.env);
				assert.notEqual(H, f.B);
				assert.equal(runGit(f.remote, ["rev-parse", f.baseRef], f.env), H);
				assert.equal(
					runGit(f.worktree, ["rev-parse", "HEAD^{tree}"], f.env),
					T,
				);
				assert.equal(runGit(f.worktree, ["status", "--porcelain"], f.env), "");
				assert.equal(
					runGit(f.worktree, ["rev-list", "--count", `${f.B}..HEAD`], f.env),
					"4",
				);
				for (let i = 0; i < files.length; i++) {
					const distance = files.length - i - 1;
					assert.equal(
						runGit(
							f.worktree,
							[
								"diff-tree",
								"--no-commit-id",
								"--name-only",
								"-r",
								`HEAD~${distance}`,
							],
							f.env,
						),
						files[i],
					);
				}
			} else {
				assert.notEqual(outcome.code, 0, outcome.output);
				assert.equal(runGit(f.worktree, ["rev-parse", "HEAD"], f.env), f.B);
				assert.equal(runGit(f.remote, ["rev-parse", f.baseRef], f.env), f.B);
				assert.equal(runGit(f.worktree, ["write-tree"], f.env), T);
				assert.match(outcome.output, /LLM fatal error|LLM Fatal Error/u);
			}
		});
	});
}
