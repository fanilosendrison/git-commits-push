import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
	installCreateQualification,
	withCreateFixture,
} from "./fixtures/create-installed-qualification.mjs";
import { runGit, waitForClose } from "./fixtures/reconciler-e2e-helpers.mjs";

const repository = path.resolve(import.meta.dirname, "../..");
const preload = pathToFileURL(
	path.join(import.meta.dirname, "fixtures/mock-completeness-fetch.mjs"),
).href;
const files = [
	"a.ts",
	"b.ts",
	...Array.from({ length: 5 }, (_, i) => `tests/case-${i}.ts`),
];
const plan = (paths) => ({
	commit: {
		type: "test",
		description: "qualify complete publication",
		isBreaking: false,
	},
	files: paths,
});
let candidate;
before(async () => {
	candidate = await installCreateQualification();
});
after(async () => {
	await candidate?.cleanup();
});

async function invoke(executable, f, args, batches, cwd = f.worktree) {
	const child = spawn(executable, args, {
		cwd,
		env: {
			...f.env,
			NODE_OPTIONS: `--import=${preload}`,
			GCP_COMPLETENESS_PLANS: JSON.stringify(batches),
		},
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
	return { code: await waitForClose(child), output };
}

async function prepare(f, target = f.worktree) {
	await mkdir(path.join(target, "tests"));
	for (const file of files)
		await writeFile(path.join(target, file), "safe fixture\n");
	runGit(target, ["add", "-A"], f.env);
	return runGit(target, ["write-tree"], f.env);
}

async function persisted(f) {
	const root = path.join(f.env.TURNLOCK_RUN_DIR_ROOT, "git-commits-push-tl");
	const runs = await readdir(root);
	const state = JSON.parse(
		await readFile(path.join(root, runs[0], "state.json"), "utf8"),
	);
	return Object.values(state.data.repos)[0];
}

for (const boundary of ["compiled", "standalone"])
	for (const omitted of [1, 5])
		test(`${boundary} NEGATIVE_01/02: omission of ${omitted} files never commits, publishes or succeeds`, async () => {
			await withCreateFixture(candidate, async (f) => {
				const T = await prepare(f);
				const executable =
					boundary === "compiled"
						? path.join(repository, "bin/git-commits-push.mjs")
						: candidate.paths.publicExecutablePath;
				// Existing targeted destination, not creation: reproduces the historical mode.
				const args = [
					"--repository",
					f.worktree,
					"--push-remote",
					"origin",
					"--push-ref",
					f.baseRef,
				];
				const result = await invoke(executable, f, args, [
					[plan(files.slice(0, files.length - omitted))],
				]);
				assert.notEqual(result.code, 0, result.output);
				assert.equal(runGit(f.worktree, ["rev-parse", "HEAD"], f.env), f.B);
				assert.equal(runGit(f.remote, ["rev-parse", f.baseRef], f.env), f.B);
				assert.equal(runGit(f.worktree, ["write-tree"], f.env), T);
				const repo = await persisted(f);
				assert.equal(repo.status, "FAILED");
				assert.equal(repo.validatedSource.expectedTreeSha, T);
				assert.equal(repo.validatedSource.baseHeadSha, f.B);
				assert.deepEqual(
					new Set(repo.validatedSource.expectedChangedPaths),
					new Set(files),
				);
				assert.equal(repo.publishedSha, undefined);
				assert.equal(repo.committedShas?.length ?? 0, 0);
			});
		});

for (const mode of ["targeted", "creation", "ordinary", "retry"])
	test(`standalone POSITIVE_03/05/06/07: ${mode} verifies complete T and required remote identity`, async () => {
		await withCreateFixture(candidate, async (f) => {
			const source = mode === "ordinary" ? f.persistent : f.worktree;
			const T = await prepare(f, source);
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
			const batches =
				mode === "retry"
					? [
							[plan(files.slice(0, 2))],
							[plan(files.slice(0, 2)), plan(files.slice(2))],
						]
					: [[plan(files.slice(0, 2)), plan(files.slice(2))]];
			const result = await invoke(
				candidate.paths.publicExecutablePath,
				f,
				args,
				batches,
				source,
			);
			assert.equal(result.code, 0, result.output);
			const Hf = runGit(source, ["rev-parse", "HEAD"], f.env);
			assert.equal(runGit(source, ["rev-parse", "HEAD^{tree}"], f.env), T);
			const ref = mode === "creation" ? f.scope.pushRef : f.baseRef;
			assert.equal(runGit(f.remote, ["rev-parse", ref], f.env), Hf);
			assert.equal(runGit(source, ["status", "--porcelain"], f.env), "");
			const repo = await persisted(f);
			assert.equal(repo.status, "SUCCESS");
			assert.equal(repo.validatedSource.expectedTreeSha, T);
			assert.deepEqual(repo.commitCompletion, {
				finalHeadSha: Hf,
				finalTreeSha: T,
			});
			assert.equal(repo.publishedSha, Hf);
			assert.equal(repo.committedShas.length, 2);
		});
	});
