import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { PhaseIO } from "turnlock";
import { stateSchema } from "../../src/config/state-schema.ts";
import { PartialCommitError } from "../../src/modules/core/errors.ts";
import { retryJobs } from "../../src/modules/core/queue-retry.ts";
import { processRepoValidationAndDiff } from "../../src/modules/core/validators/pre-commit-validators.ts";
import { captureExplicitPushTargetSnapshot } from "../../src/modules/git/explicit-push-target.ts";
import { executeMultiCommitAndPush } from "../../src/modules/git/publisher.ts";
import { assertValidatedSource } from "../../src/modules/git/validated-source.ts";
import { runCommitAndPushPhase } from "../../src/phases/step2-commit-push.ts";
import type { CommitPlan, GlobalState } from "../../src/types.ts";
import {
	CREATE_SETTINGS,
	createFixture,
	git,
} from "../fixtures/targeted-create.ts";

const plan = (file: string): CommitPlan => ({
	commit: {
		type: "test",
		description: "retain partial progress",
		isBreaking: false,
	},
	files: [file],
});

for (const mutation of [
	"unchanged",
	"index-race",
	"worktree-race",
	"head-race",
] as const)
	test(`first-commit fail-once retry ${mutation} retains original authority and rejects foreign progress`, async () => {
		const f = createFixture();
		const oldPath = process.env.PATH;
		const oldSettings = process.env.TURNLOCK_SKILL_SETTINGS_PATH;
		try {
			retryJobs.length = 0;
			f.repo.writeAndStage("a.ts", "a\n");
			f.repo.writeAndStage("b.ts", "b\n");
			const target = captureExplicitPushTargetSnapshot(f.repo.dir, {
				remote: "origin",
				destinationRef: "refs/heads/source",
			});
			const v = await processRepoValidationAndDiff(
				{ id: "task", path: f.repo.dir, explicitPushTargetSnapshot: target },
				CREATE_SETTINGS,
			);
			const settings = path.join(f.repo.dir, ".git", "retry-settings.json");
			writeFileSync(settings, JSON.stringify(CREATE_SETTINGS));
			process.env.TURNLOCK_SKILL_SETTINGS_PATH = settings;
			const bin = path.join(f.repo.dir, ".git", "fail-first-bin");
			mkdirSync(bin);
			const marker = path.join(f.repo.dir, ".git", "first-commit-failed");
			const realGit = execFileSync("which", ["git"], {
				encoding: "utf8",
			}).trim();
			const wrapper = path.join(bin, "git");
			writeFileSync(
				wrapper,
				`#!/bin/sh\nif [ "$1" = commit ] && [ ! -f ${JSON.stringify(marker)} ]; then touch ${JSON.stringify(marker)}; exit 71; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
			);
			chmodSync(wrapper, 0o755);
			process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ""}`;
			const plans = [plan("a.ts"), plan("b.ts")];
			const seen: { phase: string; state: GlobalState; prompts: string[] }[] =
				[];
			const io = {
				runId: "first-failure-fixture",
				runDir: path.join(f.repo.dir, ".git"),
				consumePendingBatchResults: () => [
					{ id: "task", success: true, commits: plans },
				],
				delegateBatch: (
					request: { jobs: { prompt: string }[] },
					phase: string,
					state: GlobalState,
				) => {
					seen.push({
						phase,
						state,
						prompts: request.jobs.map((job) => job.prompt),
					});
					return {};
				},
			} as unknown as PhaseIO<GlobalState>;
			await runCommitAndPushPhase(
				{
					invocationScope: {
						kind: "targeted",
						repository: f.repo.dir,
						pushRemote: "origin",
						pushRef: "refs/heads/source",
					},
					repos: {
						task: {
							repository: f.repo.dir,
							status: "RUNNING",
							operation: "commit-and-push",
							validatedSource: v.validatedSource,
							explicitPushTargetSnapshot: target,
							diffHash: v.diffHash,
						},
					},
				},
				io,
			);
			const first = seen.at(-1);
			assert.ok(first);
			assert.equal(first.phase, "commit-and-push");
			assert.equal(git(f.repo.dir, ["rev-parse", "HEAD"]), f.baseSha);
			assert.notEqual(
				git(f.repo.dir, ["write-tree"]),
				v.validatedSource.expectedTreeSha,
			);
			assert.equal(first.state.repos.task?.attempts?.git, 1);
			assert.equal(first.state.repos.task?.committedShas?.length ?? 0, 0);
			assert.equal(
				first.state.repos.task?.validatedSource?.expectedTreeSha,
				v.validatedSource.expectedTreeSha,
			);
			const resumed = stateSchema.parse(
				JSON.parse(JSON.stringify(first.state)),
			);
			assert.equal(
				resumed.repos.task?.publisherIndexTreeSha,
				git(f.repo.dir, ["write-tree"]),
			);
			const payload = JSON.parse(first.prompts[0] ?? "{}");
			assert.equal(payload.diffHash, v.diffHash);
			assert.equal(payload.diff, v.diff);
			if (mutation === "index-race") {
				git(f.repo.dir, ["reset", "--mixed"]);
				git(f.repo.dir, ["add", "--", "b.ts"]);
			}
			if (mutation === "worktree-race")
				writeFileSync(path.join(f.repo.dir, "b.ts"), "unvalidated\n");
			if (mutation === "head-race")
				git(f.repo.dir, [
					"commit",
					"--no-verify",
					"-m",
					"test: foreign progress",
				]);
			const beforeHead = git(f.repo.dir, ["rev-parse", "HEAD"]);
			const beforeIndex = git(f.repo.dir, ["write-tree"]);
			await runCommitAndPushPhase(resumed, io);
			const terminal = seen.at(-1);
			assert.ok(terminal);
			assert.equal(terminal.phase, "commit-outcome");
			const repo = terminal.state.repos.task;
			assert.ok(repo);
			if (mutation === "unchanged") {
				assert.equal(repo.status, "SUCCESS");
				assert.equal(repo.committedShas?.length, 2);
				assert.equal(repo.publishedSha, git(f.repo.dir, ["rev-parse", "HEAD"]));
				assert.equal(
					git(f.repo.dir, ["rev-parse", "HEAD^{tree}"]),
					v.validatedSource.expectedTreeSha,
				);
			} else {
				assert.equal(repo.status, "FAILED");
				assert.equal(git(f.repo.dir, ["rev-parse", "HEAD"]), beforeHead);
				assert.equal(git(f.repo.dir, ["write-tree"]), beforeIndex);
				assert.equal(
					git(f.remote, ["rev-parse", "refs/heads/source"]),
					f.baseSha,
				);
			}
			assert.equal(repo.validatedSource?.baseHeadSha, f.baseSha);
			assert.equal(
				repo.validatedSource?.expectedTreeSha,
				v.validatedSource.expectedTreeSha,
			);
		} finally {
			retryJobs.length = 0;
			if (oldPath === undefined) delete process.env.PATH;
			else process.env.PATH = oldPath;
			if (oldSettings === undefined)
				delete process.env.TURNLOCK_SKILL_SETTINGS_PATH;
			else process.env.TURNLOCK_SKILL_SETTINGS_PATH = oldSettings;
			f.repo.dispose();
		}
	});

for (const retry of [
	"complete",
	"empty",
	"failure",
	"changed",
	"repeated",
] as const)
	test(`NEGATIVE_03/04 and POSITIVE_04: real second-commit failure then ${retry}`, async () => {
		const f = createFixture();
		const originalPath = process.env.PATH;
		try {
			f.repo.writeAndStage("a.ts", "a\n");
			f.repo.writeAndStage("b.ts", "b\n");
			const v = await processRepoValidationAndDiff(
				{ id: "task", path: f.repo.dir },
				CREATE_SETTINGS,
			);
			const bin = path.join(f.repo.dir, ".git", "fail-commit-bin");
			mkdirSync(bin);
			const realGit = execFileSync("which", ["git"], {
				encoding: "utf8",
			}).trim();
			const marker = path.join(f.repo.dir, ".git", "first-commit");
			const wrapper = path.join(bin, "git");
			writeFileSync(
				wrapper,
				`#!/bin/sh\nif [ "$1" = commit ]; then\n if [ -f ${JSON.stringify(marker)} ]; then exit 71; fi\n ${JSON.stringify(realGit)} "$@"\n code=$?\n if [ "$code" = 0 ]; then touch ${JSON.stringify(marker)}; fi\n exit "$code"\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
			);
			chmodSync(wrapper, 0o755);
			process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
			let failure: unknown;
			try {
				await executeMultiCommitAndPush(
					f.repo.dir,
					[plan("a.ts"), plan("b.ts")],
					v.diffHash,
					CREATE_SETTINGS,
					undefined,
					{ witness: v.validatedSource },
				);
			} catch (error) {
				failure = error;
			}
			assert.ok(failure instanceof PartialCommitError);
			const committedShas = failure.context.committedShas;
			assert.equal(committedShas.length, 1);
			const first = committedShas[0]?.sha;
			assert.equal(git(f.repo.dir, ["rev-parse", "HEAD"]), first);
			assert.deepEqual(
				assertValidatedSource(f.repo.dir, v.validatedSource, committedShas)
					.remainingPaths,
				["b.ts"],
			);
			if (retry !== "failure") process.env.PATH = originalPath;
			if (retry === "changed")
				writeFileSync(path.join(f.repo.dir, "b.ts"), "unvalidated\n");
			const action = () =>
				executeMultiCommitAndPush(
					f.repo.dir,
					retry === "empty"
						? []
						: retry === "repeated"
							? [{ ...plan("b.ts"), files: ["a.ts", "b.ts"] }]
							: [plan("b.ts")],
					v.diffHash,
					CREATE_SETTINGS,
					undefined,
					{ witness: v.validatedSource, committedShas },
				);
			if (retry === "complete") {
				await action();
				assert.equal(git(f.repo.dir, ["rev-parse", "HEAD~1"]), first);
				assert.equal(
					git(f.repo.dir, ["rev-parse", "HEAD^{tree}"]),
					v.validatedSource.expectedTreeSha,
				);
			} else {
				await assert.rejects(action());
				assert.equal(git(f.repo.dir, ["rev-parse", "HEAD"]), first);
			}
			assert.equal(
				git(f.remote, ["rev-parse", "refs/heads/source"]),
				f.baseSha,
			);
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			f.repo.dispose();
		}
	});

test("NEGATIVE_10: post-commit mutation preserves created commit and blocks remote publication", async () => {
	const f = createFixture();
	try {
		f.repo.writeAndStage("a.ts", "validated\n");
		const target = captureExplicitPushTargetSnapshot(f.repo.dir, {
			remote: "origin",
			destinationRef: "refs/heads/source",
		});
		const v = await processRepoValidationAndDiff(
			{ id: "task", path: f.repo.dir, explicitPushTargetSnapshot: target },
			CREATE_SETTINGS,
		);
		git(f.repo.dir, [
			"config",
			"core.hooksPath",
			path.join(f.repo.dir, ".git", "hooks"),
		]);
		const hook = path.join(f.repo.dir, ".git", "hooks", "post-commit");
		writeFileSync(hook, "#!/bin/sh\nprintf 'unvalidated\\n' > a.ts\n");
		chmodSync(hook, 0o755);
		let failure: unknown;
		try {
			await executeMultiCommitAndPush(
				f.repo.dir,
				[plan("a.ts")],
				v.diffHash,
				CREATE_SETTINGS,
				target,
				{ witness: v.validatedSource },
			);
		} catch (error) {
			failure = error;
		}
		assert.ok(failure instanceof PartialCommitError);
		assert.equal(failure.context.committedShas.length, 1);
		assert.notEqual(git(f.repo.dir, ["rev-parse", "HEAD"]), f.baseSha);
		assert.equal(git(f.remote, ["rev-parse", "refs/heads/source"]), f.baseSha);
	} finally {
		f.repo.dispose();
	}
});
