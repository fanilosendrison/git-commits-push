import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import {
	installCreateQualification,
	startInstalled,
	withCreateFixture,
} from "./fixtures/create-installed-qualification.mjs";
import { readJsonLines, runGit } from "./fixtures/reconciler-e2e-helpers.mjs";

let candidate;
before(async () => {
	candidate = await installCreateQualification();
});
after(async () => {
	await candidate?.cleanup();
});

for (const mode of ["dirty", "clean-ahead"])
	test(`C21 C32 C34 | installed ${mode} refuses a secret hidden by ambient textconv`, async () => {
		await withCreateFixture(candidate, async (f) => {
			runGit(
				f.worktree,
				["config", "diff.mask.textconv", "printf harmless"],
				f.env,
			);
			await writeFile(
				path.join(f.worktree, ".gitattributes"),
				"credentials.txt diff=mask\n",
			);
			const synthetic = `sk-${"A".repeat(48)}`;
			await writeFile(
				path.join(f.worktree, "credentials.txt"),
				`OPENAI_API_KEY=${synthetic}\n`,
			);
			if (mode === "clean-ahead") {
				runGit(f.worktree, ["add", "-A"], f.env);
				runGit(
					f.worktree,
					["commit", "--no-verify", "-m", "feat: outgoing material"],
					f.env,
				);
			}
			const before = runGit(f.worktree, ["rev-parse", "HEAD"], f.env);
			const result = await startInstalled(candidate, f).done();
			assert.notEqual(result.code, 0, result.output);
			assert.match(result.output, /Secret|Security/u);
			assert.ok(
				!result.output.includes(synthetic),
				"diagnostics must not expose the rejected value",
			);
			assert.equal(runGit(f.worktree, ["rev-parse", "HEAD"], f.env), before);
			assert.equal(
				runGit(
					f.remote,
					["for-each-ref", "--format=%(objectname)", f.scope.pushRef],
					f.env,
				),
				"",
			);
			assert.deepEqual(await readJsonLines(f.env.MOCK_LLM_REQUEST_LOG), []);
		});
	});

test("C07 C20 C34 | installed dirty-at-B refuses missing diff objects without fetching or staging", async () => {
	await withCreateFixture(candidate, async (f) => {
		const blob = runGit(f.worktree, ["rev-parse", `${f.B}:README.md`], f.env);
		const objectPath = path.resolve(
			f.worktree,
			runGit(
				f.worktree,
				[
					"rev-parse",
					"--git-path",
					`objects/${blob.slice(0, 2)}/${blob.slice(2)}`,
				],
				f.env,
			),
		);
		runGit(f.worktree, ["config", "core.repositoryformatversion", "1"], f.env);
		runGit(f.worktree, ["config", "extensions.partialClone", "origin"], f.env);
		runGit(f.worktree, ["config", "remote.origin.promisor", "true"], f.env);
		await unlink(objectPath);
		await writeFile(
			path.join(f.worktree, "README.md"),
			"owned dirty content\n",
		);
		const trace = path.join(f.root, "dirty-input.trace");
		const result = await startInstalled(candidate, f, f.args, {
			GIT_TRACE: trace,
		}).done();
		assert.notEqual(result.code, 0, result.output);
		assert.match(result.output, /prerequisite|local.*object/iu);
		assert.ok(!/\bfetch\b/u.test(await readFile(trace, "utf8")));
		assert.equal(runGit(f.worktree, ["rev-parse", "HEAD"], f.env), f.B);
		assert.equal(
			runGit(f.worktree, ["ls-files", "--stage", "README.md"], f.env).split(
				/\s+/u,
			)[1],
			blob,
		);
		assert.equal(
			await readFile(path.join(f.worktree, "README.md"), "utf8"),
			"owned dirty content\n",
		);
		assert.equal(
			runGit(
				f.remote,
				["for-each-ref", "--format=%(objectname)", f.scope.pushRef],
				f.env,
			),
			"",
		);
		assert.deepEqual(await readJsonLines(f.env.MOCK_LLM_REQUEST_LOG), []);
	});
});
