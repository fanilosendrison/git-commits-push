import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { runDiscovery } from "../../src/modules/core/discovery.ts";
import { preparePlanningDiff } from "../../src/modules/core/planning-diff.ts";
import { queueRetry, retryJobs } from "../../src/modules/core/queue-retry.ts";
import { processRepoValidationAndDiff } from "../../src/modules/core/validators/pre-commit-validators.ts";
import type { RepoState } from "../../src/types.ts";
import {
	CREATE_SETTINGS,
	createFixture,
	git,
} from "../fixtures/targeted-create.ts";

afterEach(() => {
	retryJobs.length = 0;
});

async function retryFixture() {
	const f = createFixture();
	git(f.repo.dir, ["config", "diff.mask.textconv", "printf harmless"]);
	git(f.repo.dir, ["config", "color.diff", "always"]);
	git(f.repo.dir, ["config", "diff.noprefix", "true"]);
	fs.writeFileSync(
		path.join(f.repo.dir, ".gitattributes"),
		"work.txt diff=mask\n",
	);
	fs.writeFileSync(
		path.join(f.repo.dir, "work.txt"),
		"validated safe content\n",
	);
	const [repo] = await runDiscovery(CREATE_SETTINGS, f.scope());
	assert.ok(repo?.explicitPushTargetSnapshot);
	const validation = await processRepoValidationAndDiff(repo, CREATE_SETTINGS);
	const state: RepoState = {
		repository: f.repo.dir,
		status: "RUNNING",
		operation: "commit-and-push",
		explicitPushTargetSnapshot: repo.explicitPushTargetSnapshot,
		diffHash: validation.diffHash,
	};
	return { f, state, validation };
}

test("creation planning retains the existing 3,000,000-character default cap", async () => {
	const { f } = await retryFixture();
	try {
		const diff = "x".repeat(3_000_001);
		const prepared = preparePlanningDiff(
			diff,
			f.repo.dir,
			CREATE_SETTINGS,
			true,
		);
		assert.ok(prepared.startsWith("x".repeat(3_000_000)));
		assert.ok(
			prepared.includes(
				"DIFF TRUNCATED — 3000001 chars total, showing first 3000000 chars",
			),
		);
		assert.ok(!prepared.includes("harmless"));
		assert.ok(
			!prepared.includes("validated safe content"),
			"stat fallback must not append a second complete patch",
		);
	} finally {
		f.repo.dispose();
	}
});

test("creation message repair preserves the rejected plan and original validated hash", async () => {
	const { f, state, validation } = await retryFixture();
	try {
		const rejected = [
			{
				commit: {
					type: "feat",
					description: "overlong subject ".repeat(8),
					isBreaking: false,
				},
				files: ["work.txt"],
			},
		];
		const result = queueRetry(
			"repo",
			{ ...state, attempts: { validation: 1 } },
			[{ kind: "validation", message: "repair only the subject" }],
			{},
			CREATE_SETTINGS,
			"",
			rejected,
		);
		assert.ok(result.kind === "queued");
		const payload = JSON.parse(result.job.prompt) as {
			mode: string;
			rejectedPlans: unknown;
			diffHash: string;
		};
		assert.equal(payload.mode, "repair-commit-messages");
		assert.deepEqual(payload.rejectedPlans, rejected);
		assert.equal(payload.diffHash, validation.diffHash);
	} finally {
		f.repo.dispose();
	}
});

for (const kind of ["provider", "structural"] as const)
	test(`C20 | ${kind} retry retains the already validated raw diff and hash`, async () => {
		const { f, state, validation } = await retryFixture();
		try {
			if (kind === "structural") git(f.repo.dir, ["reset", "--mixed"]);
			const result = queueRetry(
				"repo",
				{
					...state,
					attempts: kind === "provider" ? { provider: 1 } : { structural: 1 },
				},
				[{ kind, message: "bounded retry" }],
				{},
				CREATE_SETTINGS,
				"",
				[],
			);
			assert.ok(result.kind === "queued");
			const payload = JSON.parse(result.job.prompt) as {
				diff: string;
				diffHash: string;
			};
			assert.equal(payload.diff, validation.diff);
			assert.equal(payload.diffHash, validation.diffHash);
			assert.equal(result.repoState.diffHash, validation.diffHash);
			assert.equal(git(f.repo.dir, ["rev-parse", "HEAD"]), f.baseSha);
		} finally {
			f.repo.dispose();
		}
	});

for (const mutation of ["index", "worktree", "untracked"] as const)
	test(`C20 C32 | ${mutation} changes cannot enter a provider retry prompt`, async () => {
		const { f, state } = await retryFixture();
		try {
			if (mutation === "index")
				f.repo.writeAndStage("work.txt", "changed staged content\n");
			else if (mutation === "worktree")
				fs.writeFileSync(
					path.join(f.repo.dir, "work.txt"),
					"changed unstaged content\n",
				);
			else
				fs.writeFileSync(
					path.join(f.repo.dir, "late.txt"),
					"new unvalidated content\n",
				);
			const before = fs.readFileSync(path.join(f.repo.dir, ".git", "index"));
			assert.throws(
				() =>
					queueRetry(
						"repo",
						{ ...state, attempts: { provider: 1 } },
						[{ kind: "provider", message: "bounded retry" }],
						{},
						CREATE_SETTINGS,
						"",
						[],
					),
				/changed|validated|replan/u,
			);
			assert.equal(retryJobs.length, 0);
			assert.deepEqual(
				fs.readFileSync(path.join(f.repo.dir, ".git", "index")),
				before,
			);
			assert.equal(git(f.repo.dir, ["rev-parse", "HEAD"]), f.baseSha);
		} finally {
			f.repo.dispose();
		}
	});
