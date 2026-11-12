import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import {
	buildSimplePrompt,
	createGoogleAdapter,
} from "@fanilosendrison/llm-runtime";
import { PartialCommitError } from "../../src/modules/core/errors.ts";
import { handleLlmJobFailure } from "../../src/modules/core/llm-job-failure-handler.ts";
import { retryJobs } from "../../src/modules/core/queue-retry.ts";
import { executeMultiCommitAndPush } from "../../src/modules/git/publisher.ts";
import { buildContextRequest } from "../../src/modules/llm/context-request.ts";
import {
	invokeLlm,
	type LlmAdapterFactories,
} from "../../src/modules/llm/llm-invoker.ts";
import { createLlmJobFailure } from "../../src/modules/llm/provider-failure.ts";
import {
	executePlanningJob,
	renderPlanningInvocation,
} from "../../src/modules/planning/planning-job.ts";
import { readPlanningPathInputs } from "../../src/modules/planning/planning-source.ts";
import { createSkillStatsLog } from "../../src/modules/telemetry/stats-logger.ts";
import type { CommitPlanningPayload } from "../../src/types.ts";
import {
	fixture,
	fixtureBridge,
	git,
	settings,
	transport,
} from "../fixtures/context-planning.ts";
import { syntheticContextAuthority } from "../helpers/context-authority.ts";

const originalFetch = globalThis.fetch;
before(() => {
	globalThis.fetch = async () => {
		throw new Error(
			"Forbidden real provider transport in deterministic fixture",
		);
	};
});
after(() => {
	globalThis.fetch = originalFetch;
});

test("literal Git paths, binary, deletion, rename and mode changes aggregate before actual bare-remote publication", async () => {
	const f = await fixture();
	try {
		const source = f.payload.planningSource;
		assert.ok(source);
		const inputs = readPlanningPathInputs(
			f.repo.dir,
			source,
			f.validated.diffHash,
		);
		assert(inputs.some((p) => p.patch.includes("GIT binary patch")));
		assert(inputs.some((p) => p.patch.includes("Unicode é 😀 �")));
		assert(inputs.some((p) => p.patch.includes("deleted file mode")));
		assert(inputs.some((p) => p.patch.includes("new mode 100755")));
		assert(inputs.some((p) => p.path === "old name.txt"));
		assert(inputs.some((p) => p.path === "new name.txt"));
		const t = transport(f);
		const result = await fixtureBridge(f, t);
		assert.equal(result.success, true);
		const plans = result.commits;
		assert(t.calls.length > 1);
		assert.deepEqual(
			plans.flatMap((p) => p.files).sort(),
			[...f.validated.validatedSource.expectedChangedPaths].sort(),
		);
		await executeMultiCommitAndPush(
			f.repo.dir,
			plans,
			f.validated.diffHash,
			settings,
			undefined,
			{ witness: f.validated.validatedSource },
		);
		assert.equal(
			git(f.repo.dir, "rev-parse", "HEAD^{tree}"),
			f.validated.validatedSource.expectedTreeSha,
		);
		assert.equal(
			git(f.remote, "rev-parse", "HEAD"),
			git(f.repo.dir, "rev-parse", "HEAD"),
		);
	} finally {
		f.dispose();
	}
});

test("actual bridge marks schema-valid incomplete partition coverage as structural, without malformed repeats or effects", async () => {
	const f = await fixture();
	try {
		const t = transport(f, 1, 10_000_000, true);
		const result = await fixtureBridge(f, t);
		assert.equal(result.success, false);
		assert.equal(result.planningFailureKind, "structural");
		assert.equal(result.providerFailureKind, undefined);
		assert.equal(t.calls.length, 2);
		assert.equal(git(f.repo.dir, "rev-parse", "HEAD"), f.head);
		assert.equal(git(f.remote, "rev-parse", "HEAD"), f.head);
	} finally {
		f.dispose();
	}
});

test("later partition failure cannot publish earlier successful plans", async () => {
	const f = await fixture();
	try {
		const t = transport(f, 1);
		await assert.rejects(
			executePlanningJob(f.payload, "synthetic", t.invoke, t.authority),
			/invalid response/,
		);
		assert(t.calls.length >= 3);
		assert.equal(git(f.repo.dir, "rev-parse", "HEAD"), f.head);
		assert.equal(git(f.remote, "rev-parse", "HEAD"), f.head);
		assert.equal(
			git(
				f.repo.dir,
				"diff",
				"--cached",
				"--name-only",
				f.validated.validatedSource.expectedTreeSha,
			),
			"",
		);
	} finally {
		f.dispose();
	}
});

test("a post-aggregation commit failure preserves landed history and pending evidence", async () => {
	const f = await fixture();
	try {
		const t = transport(f);
		const plans = await executePlanningJob(
			f.payload,
			"synthetic",
			t.invoke,
			t.authority,
		);
		assert(plans.length > 1);
		git(
			f.repo.dir,
			"config",
			"core.hooksPath",
			path.join(f.repo.dir, ".git/hooks"),
		);
		const hook = path.join(f.repo.dir, ".git/hooks/post-commit");
		// Production commits use --no-verify; post-commit remains observable and
		// creates an independent source-race oracle after the first landed commit.
		writeFileSync(
			hook,
			"#!/bin/sh\nprintf 'unvalidated\\n' > 'unicode-😀-\".txt'\n",
		);
		chmodSync(hook, 0o755);
		await assert.rejects(
			executeMultiCommitAndPush(
				f.repo.dir,
				plans,
				f.validated.diffHash,
				settings,
				undefined,
				{ witness: f.validated.validatedSource },
			),
			(error) => {
				assert(error instanceof PartialCommitError);
				assert.equal(error.context.committedShas.length, 1);
				assert(error.context.pendingFiles.length > 0);
				return true;
			},
		);
		assert.notEqual(git(f.repo.dir, "rev-parse", "HEAD"), f.head);
		assert.equal(git(f.remote, "rev-parse", "HEAD"), f.head);
		assert.equal(
			readFileSync(path.join(f.repo.dir, 'unicode-😀-".txt'), "utf8"),
			"unvalidated\n",
		);
	} finally {
		f.dispose();
	}
});

test("typed primary outage selects one smaller fallback whose feedback requests repartition before aggregation", async () => {
	const f = await fixture();
	retryJobs.length = 0;
	try {
		const authority = syntheticContextAuthority();
		let primaryCalls = 0;
		const unexpected = () => {
			throw new Error("unexpected provider");
		};
		const factories: LlmAdapterFactories = {
			contextAuthority: authority,
			buildSimplePrompt,
			createAnthropicAdapter: unexpected,
			createOpenAIAdapter: unexpected,
			createOpenAICompatibleAdapter: unexpected,
			createGoogleAdapter: (config) =>
				createGoogleAdapter({
					...config,
					retry: {
						maxAttempts: config.retry?.maxAttempts ?? 1,
						backoffBaseMs: 0,
						maxBackoffMs: 0,
					},
					providerOptions: {
						fetch: async () => {
							primaryCalls++;
							return new Response('{"error":{"message":"synthetic outage"}}', {
								status: 503,
							});
						},
					},
				}),
		};
		let outage: unknown;
		try {
			await executePlanningJob(
				{ ...f.payload, provider: "google", model: "synthetic-primary" },
				"synthetic",
				(p, _unused, budget) => invokeLlm(p, factories, budget),
				authority,
			);
		} catch (error) {
			outage = error;
		}
		assert.equal(primaryCalls, 5);
		assert.ok(outage);
		const outcome = createLlmJobFailure("fixture", outage);
		assert.equal(outcome.providerFailureKind, "transient_provider");
		const next = handleLlmJobFailure({
			result: outcome,
			repoState: {
				repository: f.repo.dir,
				status: "RUNNING",
				validatedSource: f.validated.validatedSource,
				diffHash: f.validated.diffHash,
				lastPlanHash: "genuine-prior-plan",
			},
			runId: "synthetic-fallback",
			settings: {
				...settings,
				provider: "google",
				model: "synthetic-primary",
				fallbackProvider: "mistral",
				fallbackModel: "synthetic-small",
			},
			skillLog: createSkillStatsLog(),
			systemPrompt: f.payload.systemPrompt,
		});
		assert.equal(next.fallbackAttempted, true);
		assert.equal(next.lastPlanHash, "genuine-prior-plan");
		assert.equal(next.attempts?.provider, 1);
		assert.equal(retryJobs.length, 1);
		const queued = JSON.parse(
			retryJobs[0]?.prompt ?? "",
		) as CommitPlanningPayload;
		assert.equal(queued.provider, "mistral");
		assert.equal(queued.feedback?.errors[0]?.kind, "provider");
		assert.ok(queued.planningSource);
		const source = { ...queued.planningSource, maxDiffChars: 10000 };
		const payload = { ...queued, planningSource: source };
		const inputs = readPlanningPathInputs(f.repo.dir, source, queued.diffHash);
		const bytes = (paths: string[], diff: string) =>
			Buffer.byteLength(
				JSON.stringify(
					buildContextRequest(
						renderPlanningInvocation(payload, "synthetic", { paths, diff }),
					),
				),
			);
		const bound =
			Math.max(...inputs.map((input) => bytes([input.path], input.patch))) + 10;
		assert(
			bytes(
				inputs.map((input) => input.path),
				inputs.map((input) => input.patch).join(""),
			) > bound,
		);
		const fallback = transport(f, undefined, bound);
		const plans = await executePlanningJob(
			payload,
			"synthetic",
			fallback.invoke,
			fallback.authority,
		);
		assert(fallback.calls.length > 1);
		assert.deepEqual(
			plans.flatMap((plan) => plan.files).sort(),
			[...source.witness.expectedChangedPaths].sort(),
		);
		assert.equal(git(f.repo.dir, "rev-parse", "HEAD"), f.head);
		assert.equal(git(f.remote, "rev-parse", "HEAD"), f.head);
	} finally {
		retryJobs.length = 0;
		f.dispose();
	}
});
