import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { runDiscovery } from "../../src/modules/core/discovery.ts";
import {
	captureRepositoryState,
	computeStateJson,
	writeLLMResultToTurnlockRunDir,
} from "../helpers/test-helpers.ts";
import {
	installCreateQualification,
	startInstalled,
	withCreateFixture,
} from "./fixtures/create-installed-qualification.mjs";
import {
	startLlmOverlapServer,
	waitForCondition,
} from "./fixtures/execution-lifetime-helpers.mjs";
import {
	createRepoWithBareRemote,
	readJsonLines,
	runGit,
} from "./fixtures/reconciler-e2e-helpers.mjs";

let candidate;
before(async () => {
	candidate = await installCreateQualification();
});
after(async () => {
	await candidate?.cleanup();
});

for (const mode of ["dirty", "ahead", "at-base"])
	test(`C10 C11 C12 C29 C30 C34 | installed ${mode} creates exactly S in its isolated worktree`, async () => {
		await withCreateFixture(candidate, async (f) => {
			assert.notEqual(
				spawnSync("pnpm", ["--version"], { env: f.env }).status,
				0,
			);
			if (mode !== "at-base")
				await writeFile(
					path.join(f.worktree, "task.ts"),
					"export const work = true;\n",
				);
			if (mode === "ahead") {
				runGit(f.worktree, ["add", "task.ts"], f.env);
				runGit(
					f.worktree,
					["commit", "--no-verify", "-m", "feat: task"],
					f.env,
				);
			}
			await writeFile(path.join(f.persistent, "sentinel"), "untouched\n");
			const beforeState = captureRepositoryState(f.persistent);
			const protectedStates = new Map();
			if (mode === "dirty") {
				const sibling = path.join(f.root, "sibling-worktree");
				runGit(
					f.persistent,
					["worktree", "add", "--detach", sibling, f.B],
					f.env,
				);
				await writeFile(path.join(sibling, "sibling-sentinel"), "untouched\n");
				const neighbor = path.join(f.root, "neighbor");
				await createRepoWithBareRemote(
					neighbor,
					path.join(f.root, "neighbor.git"),
					f.env,
				);
				await writeFile(
					path.join(neighbor, "neighbor-sentinel"),
					"untouched\n",
				);
				for (const repository of [sibling, neighbor])
					protectedStates.set(repository, captureRepositoryState(repository));
				await writeFile(
					f.env.TURNLOCK_SKILL_SETTINGS_PATH,
					JSON.stringify({ ...f.settings, searchPaths: [f.root] }),
				);
			}
			const result = await startInstalled(candidate, f).done();
			assert.equal(result.code, 0, result.output);
			const S = runGit(f.worktree, ["rev-parse", "HEAD"], f.env);
			assert.equal(runGit(f.remote, ["rev-parse", f.scope.pushRef], f.env), S);
			assert.equal(runGit(f.worktree, ["status", "--porcelain"], f.env), "");
			assert.equal(captureRepositoryState(f.persistent), beforeState);
			for (const [repository, state] of protectedStates)
				assert.equal(captureRepositoryState(repository), state);
			assert.equal(
				runGit(f.remote, ["for-each-ref", "--format=%(refname)"], f.env),
				[f.baseRef, f.scope.pushRef].sort().join("\n"),
			);
			const requests = await readJsonLines(f.env.MOCK_LLM_REQUEST_LOG);
			assert.equal(requests.length, mode === "dirty" ? 1 : 0);
			const runs = await readdir(
				path.join(f.env.TURNLOCK_RUN_DIR_ROOT, "git-commits-push-tl"),
			);
			const persisted = JSON.parse(
				await readFile(
					path.join(
						f.env.TURNLOCK_RUN_DIR_ROOT,
						"git-commits-push-tl",
						runs[0],
						"state.json",
					),
					"utf8",
				),
			);
			assert.deepEqual(persisted.data.invocationScope, f.scope);
			const repo = Object.values(persisted.data.repos)[0];
			assert.equal(repo.status, "SUCCESS");
			assert.equal(repo.publishedSha, S);
			const evidence =
				mode === "dirty" ? repo.creationPublicationSnapshot : repo.pushSnapshot;
			assert.equal(evidence.kind, "explicit-create");
			assert.equal(evidence.baseSha, f.B);
			assert.equal(evidence.validatedHeadSha, S);
			assert.equal(evidence.outgoingShas.length, mode === "at-base" ? 0 : 1);
			if (mode === "at-base") {
				runGit(f.remote, ["update-ref", "-d", f.scope.pushRef], f.env);
				const resumed = await startInstalled(candidate, f, [
					"--resume",
					"--run-id",
					runs[0],
				]).done();
				assert.equal(resumed.code, 0, resumed.output);
				assert.equal(
					runGit(
						f.remote,
						["for-each-ref", "--format=%(objectname)", f.scope.pushRef],
						f.env,
					),
					"",
					"a genuinely completed publication must not be recreated after deletion",
				);
			}
		});
	});

for (const sameDestination of [false, true])
	test(`C14 C24 C25 C34 | installed concurrent creation ${sameDestination ? "same" : "different"} destinations serializes without losing authority`, async () => {
		await withCreateFixture(candidate, async (f) => {
			const server = await startLlmOverlapServer();
			const children = [];
			try {
				const preload = pathToFileURL(
					path.join(
						import.meta.dirname,
						"fixtures/mock-openai-fetch-overlap.mjs",
					),
				).href;
				const extra = {
					GCP_TEST_LLM_SERVER_URL: server.url,
					NODE_OPTIONS: `--import=${preload}`,
				};
				await writeFile(
					path.join(f.worktree, "a-task.ts"),
					"export const a = true;\n",
				);
				const other = path.join(f.root, "other-task");
				runGit(
					f.persistent,
					["worktree", "add", "--detach", other, f.B],
					f.env,
				);
				await writeFile(
					path.join(other, "b-task.ts"),
					"export const b = true;\n",
				);
				const a = startInstalled(candidate, f, f.args, extra);
				children.push(a.child);
				await waitForCondition(
					() => server.events.some((e) => e.type === "request_opened"),
					"creation did not reach LLM barrier",
				);
				const dbPath = path.join(f.env.ORDER_STATE_DIR, "reconciler.sqlite");
				const readRow = () => {
					const db = new DatabaseSync(dbPath);
					try {
						return db.prepare("SELECT * FROM reconciler_state").get();
					} finally {
						db.close();
					}
				};
				const beforeRow = readRow();
				assert.equal(beforeRow.owner_invocation_mode, "targeted");
				const otherArgs = [...f.args];
				otherArgs[1] = other;
				if (!sameDestination) otherArgs[5] = "refs/heads/other-task";
				const b = startInstalled(candidate, f, otherArgs, extra);
				children.push(b.child);
				await new Promise((resolve) => setTimeout(resolve, 1000));
				assert.equal(b.child.exitCode, null);
				const during = readRow();
				assert.equal(
					during.requested_generation,
					beforeRow.requested_generation,
				);
				assert.equal(during.execution_token, beforeRow.execution_token);
				server.release();
				const resultA = await a.done();
				const resultB = await b.done();
				assert.equal(resultA.code, 0, resultA.output);
				assert.equal(resultB.code === 0, !sameDestination, resultB.output);
				assert.equal(server.overlapDetected(), false);
				assert.equal(server.maximumActiveExecutions(), 1);
				assert.equal(
					runGit(f.remote, ["rev-parse", f.scope.pushRef], f.env),
					runGit(f.worktree, ["rev-parse", "HEAD"], f.env),
				);
				if (sameDestination) {
					assert.equal(runGit(other, ["rev-parse", "HEAD"], f.env), f.B);
					assert.equal(
						await readFile(path.join(other, "b-task.ts"), "utf8"),
						"export const b = true;\n",
					);
				} else
					assert.equal(
						runGit(f.remote, ["rev-parse", "refs/heads/other-task"], f.env),
						runGit(other, ["rev-parse", "HEAD"], f.env),
					);
				const final = readRow();
				assert.equal(final.requested_generation, final.completed_generation);
				assert.equal(final.execution_token, null);
				assert.equal(final.owner_token, null);
			} finally {
				for (const child of children)
					if (child.exitCode === null && child.signalCode === null)
						child.kill("SIGTERM");
				await server.close();
			}
		});
	});

test("C14 C34 | installed appearance before first commit preserves dirty work and reports failure", async () => {
	await withCreateFixture(candidate, async (f) => {
		const server = await startLlmOverlapServer();
		let launch;
		try {
			await writeFile(
				path.join(f.worktree, "task.ts"),
				"export const task = true;\n",
			);
			launch = startInstalled(candidate, f, f.args, {
				GCP_TEST_LLM_SERVER_URL: server.url,
				NODE_OPTIONS: `--import=${pathToFileURL(path.join(import.meta.dirname, "fixtures/mock-openai-fetch-overlap.mjs")).href}`,
			});
			await waitForCondition(
				() => server.events.some((e) => e.type === "request_opened"),
				"creation did not reach admission barrier",
			);
			runGit(
				f.persistent,
				["push", "origin", `${f.B}:${f.scope.pushRef}`],
				f.env,
			);
			server.release();
			const result = await launch.done();
			assert.notEqual(result.code, 0, result.output);
			assert.equal(runGit(f.worktree, ["rev-parse", "HEAD"], f.env), f.B);
			assert.equal(
				runGit(f.remote, ["rev-parse", f.scope.pushRef], f.env),
				f.B,
			);
			assert.ok(existsSync(path.join(f.worktree, "task.ts")));
		} finally {
			if (launch?.child.exitCode === null) launch.child.kill("SIGTERM");
			await server.close();
		}
	});
});

for (const mode of [
	"clean-resume",
	"dirty-interrupted",
	"known-success-deleted",
])
	test(`C26 C28 C33 C34 | installed ${mode} preserves persisted creation authority`, async () => {
		await withCreateFixture(candidate, async (f) => {
			// Source discovery is fixture setup only. The resumed run executes exclusively
			// through the installed launcher under its own isolated trust environment.
			const [discovered] = await runDiscovery(f.settings, f.scope);
			const snapshot = discovered.pushSnapshot;
			let repo = {
				repository: f.worktree,
				status: "RUNNING",
				operation: "push-only",
				pushSnapshot: snapshot,
			};
			if (mode === "dirty-interrupted") {
				await writeFile(
					path.join(f.worktree, "task.ts"),
					"export const task = true;\n",
				);
				const [dirty] = await runDiscovery(f.settings, f.scope);
				runGit(f.worktree, ["add", "task.ts"], f.env);
				runGit(
					f.worktree,
					["commit", "--no-verify", "-m", "feat: work"],
					f.env,
				);
				repo = {
					repository: f.worktree,
					status: "RUNNING",
					operation: "commit-and-push",
					explicitPushTargetSnapshot: dirty.explicitPushTargetSnapshot,
					diffHash: "untrusted-after-interruption",
					committedShas: [
						{
							sha: runGit(f.worktree, ["rev-parse", "HEAD"], f.env),
							files: ["task.ts"],
						},
					],
				};
			} else if (mode === "known-success-deleted")
				repo = {
					...repo,
					status: "SUCCESS",
					pushedShas: [],
					publishedSha: f.B,
					remoteTrackingRefSynchronization: "not-applicable",
				};
			const runId = "01J00000000000000000000000";
			// Reuse the existing persisted-run fixture; the runtime reader/launcher are installed.
			computeStateJson(
				f.root,
				{ invocationScope: f.scope, repos: { task: repo } },
				runId,
			);
			writeLLMResultToTurnlockRunDir(
				f.root,
				"task",
				{ id: "task", success: true, commits: [] },
				runId,
			);
			const before = runGit(f.worktree, ["rev-parse", "HEAD"], f.env);
			const result = await startInstalled(candidate, f, [
				"--resume",
				"--run-id",
				runId,
			]).done();
			assert.equal(
				result.code === 0,
				mode !== "dirty-interrupted",
				result.output,
			);
			assert.equal(runGit(f.worktree, ["rev-parse", "HEAD"], f.env), before);
			const observed = runGit(
				f.remote,
				["for-each-ref", "--format=%(objectname)", f.scope.pushRef],
				f.env,
			);
			assert.equal(observed, mode === "clean-resume" ? f.B : "");
			assert.deepEqual(await readJsonLines(f.env.MOCK_LLM_REQUEST_LOG), []);
		});
	});
