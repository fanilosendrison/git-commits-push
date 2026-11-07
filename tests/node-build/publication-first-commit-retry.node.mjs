import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
	installCreateQualification,
	withCreateFixture,
} from "./fixtures/create-installed-qualification.mjs";
import { resolvePathExecutable } from "./fixtures/path-executable.mjs";
import { runGit, waitForClose } from "./fixtures/reconciler-e2e-helpers.mjs";

let candidate;
before(async () => {
	candidate = await installCreateQualification();
});
after(async () => {
	await candidate?.cleanup();
});
const files = [
	"a.ts",
	"b.ts",
	...Array.from({ length: 5 }, (_, i) => `tests/case-${i}.ts`),
];
const plans = [files.slice(0, 2), files.slice(2)].map((paths) => ({
	commit: {
		type: "test",
		description: "preserve first failure retry",
		isBreaking: false,
	},
	files: paths,
}));
const preload = pathToFileURL(
	path.join(import.meta.dirname, "fixtures/mock-completeness-fetch.mjs"),
).href;

for (const mode of ["ordinary", "targeted", "creation"])
	test(`installed ${mode} retries a fail-once first commit against original H0/T`, async () => {
		await withCreateFixture(candidate, async (f) => {
			const source = mode === "ordinary" ? f.persistent : f.worktree;
			await mkdir(path.join(source, "tests"));
			for (const file of files)
				await writeFile(path.join(source, file), "validated fixture\n");
			runGit(source, ["add", "-A"], f.env);
			const T = runGit(source, ["write-tree"], f.env);
			const bin = path.join(f.root, "fault-bin");
			await mkdir(bin);
			const marker = path.join(f.root, "first-commit-failed");
			const originalGit = await resolvePathExecutable("git");
			const gitWrapper = path.join(bin, "git");
			await writeFile(
				gitWrapper,
				`#!/bin/sh\nif [ "$1" = commit ] && [ ! -f ${JSON.stringify(marker)} ]; then touch ${JSON.stringify(marker)}; echo 'fixture transient first commit failure' >&2; exit 71; fi\nexec ${JSON.stringify(originalGit)} "$@"\n`,
			);
			await chmod(gitWrapper, 0o755);
			// Legacy Darwin resolves Git through xcrun; preserve that tested selection
			// boundary while injecting only the fail-once Git subprocess outcome.
			const xcrun = path.join(bin, "xcrun");
			await writeFile(
				xcrun,
				`#!/bin/sh\nif [ "$1" = --find ] && [ "$2" = git ]; then printf '%s\\n' ${JSON.stringify(gitWrapper)}; exit 0; fi\nexit 72\n`,
			);
			await chmod(xcrun, 0o755);
			if (mode === "ordinary")
				await writeFile(
					f.env.TURNLOCK_SKILL_SETTINGS_PATH,
					JSON.stringify({ ...f.settings, autoPush: true }),
				);
			const args =
				mode === "ordinary"
					? []
					: mode === "creation"
						? f.args
						: [
								"--repository",
								source,
								"--push-remote",
								"origin",
								"--push-ref",
								f.baseRef,
							];
			const launch = {
				...f,
				env: {
					...f.env,
					PATH: `${bin}${path.delimiter}${f.env.PATH}`,
					NODE_OPTIONS: `--import=${preload}`,
					GCP_COMPLETENESS_PLANS: JSON.stringify([plans]),
				},
			};
			const child = spawn(candidate.paths.publicExecutablePath, args, {
				cwd: source,
				env: launch.env,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			child.stdout.on("data", (bytes) => {
				output += bytes;
			});
			child.stderr.on("data", (bytes) => {
				output += bytes;
			});
			const result = { code: await waitForClose(child), output };
			assert.equal(result.code, 0, result.output);
			assert.equal(await readFile(marker, "utf8"), "");
			const S = runGit(source, ["rev-parse", "HEAD"], f.env);
			assert.equal(runGit(source, ["rev-parse", "HEAD^{tree}"], f.env), T);
			assert.equal(
				runGit(source, ["rev-list", "--count", `${f.B}..HEAD`], f.env),
				"2",
			);
			assert.equal(
				runGit(
					f.remote,
					["rev-parse", mode === "creation" ? f.scope.pushRef : f.baseRef],
					f.env,
				),
				S,
			);
			assert.equal(runGit(source, ["status", "--porcelain"], f.env), "");
			const runsRoot = path.join(
				f.env.TURNLOCK_RUN_DIR_ROOT,
				"git-commits-push-tl",
			);
			const runs = await readdir(runsRoot);
			const state = JSON.parse(
				await readFile(path.join(runsRoot, runs[0], "state.json"), "utf8"),
			);
			const repo = Object.values(state.data.repos)[0];
			assert.equal(repo.status, "SUCCESS");
			assert.equal(repo.attempts.git, 1);
			assert.equal(repo.attempts.race ?? 0, 0);
			assert.equal(repo.validatedSource.baseHeadSha, f.B);
			assert.equal(repo.validatedSource.expectedTreeSha, T);
			assert.deepEqual(repo.commitCompletion, {
				finalHeadSha: S,
				finalTreeSha: T,
			});
			assert.equal(repo.publishedSha, S);
			assert.equal(
				(await readFile(f.env.MOCK_LLM_REQUEST_LOG, "utf8")).trim().split("\n")
					.length,
				2,
			);
		});
	});
