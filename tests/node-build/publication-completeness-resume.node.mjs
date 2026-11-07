import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
	computeStateJson,
	writeLLMResultToTurnlockRunDir,
} from "../helpers/test-helpers.ts";
import {
	installCreateQualification,
	startInstalled,
	withCreateFixture,
} from "./fixtures/create-installed-qualification.mjs";
import { runGit } from "./fixtures/reconciler-e2e-helpers.mjs";

const RUN = "01J00000000000000000000000";
const files = [
	"a.ts",
	"b.ts",
	...Array.from({ length: 5 }, (_, i) => `tests/case-${i}.ts`),
];
let candidate;
before(async () => {
	candidate = await installCreateQualification();
});
after(async () => {
	await candidate?.cleanup();
});

for (const scenario of [
	"missing-witness",
	"legacy-discovery",
	"legacy-no-pending",
	"crash-after-commit",
	"partial-empty",
	"published-incomplete",
	"complete-without-push",
	"contradictory-publication",
	"published-complete-report",
	"published-complete-interrupted",
])
	test(`standalone resume ${scenario} preserves authority and actual effects without inventing success`, async () => {
		await withCreateFixture(candidate, async (f) => {
			const moduleUrl = (file) =>
				pathToFileURL(
					path.join(candidate.releaseDirectory, "dist/src/modules/git", file),
				).href;
			await mkdir(path.join(f.worktree, "tests"));
			for (const file of files)
				await writeFile(path.join(f.worktree, file), "safe fixture\n");
			runGit(f.worktree, ["add", "-A"], f.env);
			const T = runGit(f.worktree, ["write-tree"], f.env);
			// Fixture admission must inherit the same isolated HOME/Git environment as runtime.
			const admission = spawnSync(
				"node",
				[
					"--input-type=module",
					"--eval",
					`
				import {captureValidatedSource} from ${JSON.stringify(moduleUrl("validated-source.js"))};
				import {captureExplicitPushTargetSnapshot} from ${JSON.stringify(moduleUrl("explicit-push-target.js"))};
				const repository = ${JSON.stringify(f.worktree)};
				const target = captureExplicitPushTargetSnapshot(repository, {remote: "origin", destinationRef: ${JSON.stringify(f.baseRef)}});
				process.stdout.write(JSON.stringify({target, witness: captureValidatedSource(repository, true)}));
			`,
				],
				{
					cwd: path.join(candidate.releaseDirectory, "dist"),
					env: f.env,
					encoding: "utf8",
				},
			);
			assert.equal(admission.status, 0, admission.stderr);
			const { target, witness } = JSON.parse(admission.stdout);
			let repo = {
				repository: f.worktree,
				operation: "commit-and-push",
				status: "RUNNING",
				explicitPushTargetSnapshot: target,
				validatedSource: witness,
				diffHash: "retained-original-diff-hash",
			};
			let first;
			if (scenario !== "missing-witness") {
				const complete = [
					"crash-after-commit",
					"complete-without-push",
					"contradictory-publication",
					"published-complete-report",
					"published-complete-interrupted",
				].includes(scenario);
				if (!complete) {
					runGit(f.worktree, ["reset", "--mixed"], f.env);
					runGit(f.worktree, ["add", "--", "a.ts"], f.env);
				}
				runGit(
					f.worktree,
					["commit", "--no-verify", "-m", "test: preserve historical effects"],
					f.env,
				);
				first = runGit(f.worktree, ["rev-parse", "HEAD"], f.env);
				if (scenario !== "crash-after-commit")
					repo = {
						...repo,
						committedShas: [{ sha: first, files: complete ? files : ["a.ts"] }],
					};
				if (scenario.startsWith("published")) {
					runGit(
						f.worktree,
						["push", "origin", `${first}:${f.baseRef}`],
						f.env,
					);
					repo = {
						...repo,
						publishedSha: first,
						remoteTrackingRefSynchronization: "not-applicable",
					};
				}
				if (scenario === "published-complete-report") {
					repo = {
						...repo,
						status: "SUCCESS",
						commitCompletion: { finalHeadSha: first, finalTreeSha: T },
					};
					runGit(f.remote, ["update-ref", "-d", f.baseRef], f.env);
				}
			} else {
				delete repo.validatedSource;
			}
			if (scenario.startsWith("legacy-")) {
				delete repo.validatedSource;
				repo.originalHead = f.B;
			}
			if (scenario === "contradictory-publication")
				repo.validatedSource = { ...witness, publicationRequired: false };
			const scope = {
				kind: "targeted",
				repository: f.worktree,
				pushRemote: "origin",
				pushRef: f.baseRef,
			};
			computeStateJson(
				f.root,
				{ invocationScope: scope, repos: { task: repo } },
				RUN,
			);
			if (scenario.startsWith("legacy-")) {
				const file = path.join(
					f.env.TURNLOCK_RUN_DIR_ROOT,
					"git-commits-push-tl",
					RUN,
					"state.json",
				);
				const legacy = JSON.parse(await readFile(file, "utf8"));
				if (scenario === "legacy-no-pending") delete legacy.pendingDelegation;
				else {
					legacy.pendingDelegation.resumeAt = "discovery-and-validation";
					const manifestFile = legacy.pendingDelegation.manifestPath;
					const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
					manifest.resumeAt = "discovery-and-validation";
					await writeFile(manifestFile, JSON.stringify(manifest));
				}
				legacy.currentPhase = "discovery-and-validation";
				await writeFile(file, JSON.stringify(legacy));
			}
			if (scenario !== "legacy-no-pending")
				writeLLMResultToTurnlockRunDir(
					f.root,
					"task",
					{
						id: "task",
						success: false,
						error:
							"LLM returned a non-empty JSON array error after interruption",
					},
					RUN,
				);
			const beforeHead = runGit(f.worktree, ["rev-parse", "HEAD"], f.env);
			const beforeIndex = runGit(f.worktree, ["write-tree"], f.env);
			const result = await startInstalled(candidate, f, [
				"--resume",
				"--run-id",
				RUN,
			]).done();
			if (scenario === "legacy-discovery")
				assert.match(result.output, /Discovery resume cannot establish/);
			assert.equal(
				result.code === 0,
				scenario.startsWith("published-complete"),
				result.output,
			);
			assert.equal(
				runGit(f.worktree, ["rev-parse", "HEAD"], f.env),
				beforeHead,
			);
			assert.equal(runGit(f.worktree, ["write-tree"], f.env), beforeIndex);
			assert.equal(
				existsSync(f.env.MOCK_LLM_REQUEST_LOG),
				false,
				"terminal recovery must not request another model plan",
			);
			const state = JSON.parse(
				await readFile(
					path.join(
						f.env.TURNLOCK_RUN_DIR_ROOT,
						"git-commits-push-tl",
						RUN,
						"state.json",
					),
					"utf8",
				),
			);
			const persisted = state.data.repos.task;
			assert.equal(
				persisted.status,
				scenario.startsWith("legacy-") ||
					scenario === "contradictory-publication"
					? "RUNNING"
					: scenario.startsWith("published-complete")
						? "SUCCESS"
						: "FAILED",
			);
			if (scenario !== "missing-witness" && !scenario.startsWith("legacy-"))
				assert.equal(persisted.validatedSource.expectedTreeSha, T);
			if (scenario === "crash-after-commit")
				assert.match(persisted.error, new RegExp(first));
			if (scenario.startsWith("published"))
				assert.equal(persisted.publishedSha, first);
			const remote = runGit(
				f.remote,
				["for-each-ref", "--format=%(objectname)", f.baseRef],
				f.env,
			);
			assert.equal(
				remote,
				scenario === "published-complete-report"
					? ""
					: scenario.startsWith("published")
						? first
						: f.B,
			);
		});
	});
