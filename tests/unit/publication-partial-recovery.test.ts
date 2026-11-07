import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PartialCommitError } from "../../src/modules/core/errors.ts";
import { processRepoValidationAndDiff } from "../../src/modules/core/validators/pre-commit-validators.ts";
import { captureExplicitPushTargetSnapshot } from "../../src/modules/git/explicit-push-target.ts";
import { executeMultiCommitAndPush } from "../../src/modules/git/publisher.ts";
import { assertValidatedSource } from "../../src/modules/git/validated-source.ts";
import type { CommitPlan } from "../../src/types.ts";
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
