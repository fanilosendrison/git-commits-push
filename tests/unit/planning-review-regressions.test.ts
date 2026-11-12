import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
	AbortedError,
	AuthError,
	InvalidRequestError,
	RateLimitError,
} from "@fanilosendrison/llm-runtime";
import { commitJobResultSchema } from "../../src/config/state-schema.ts";
import { handleLlmJobFailure } from "../../src/modules/core/llm-job-failure-handler.ts";
import { retryJobs } from "../../src/modules/core/queue-retry.ts";
import { admitContext } from "../../src/modules/llm/context-admission.ts";
import { buildContextRequest } from "../../src/modules/llm/context-request.ts";
import { createLlmJobFailure } from "../../src/modules/llm/provider-failure.ts";
import { assertExactPlanningCoverage } from "../../src/modules/planning/exact-partitions.ts";
import { executePlanningJob } from "../../src/modules/planning/planning-job.ts";
import { createSkillStatsLog } from "../../src/modules/telemetry/stats-logger.ts";
import {
	fixture,
	git,
	settings,
	transport,
} from "../fixtures/context-planning.ts";
import { syntheticContextAuthority } from "../helpers/context-authority.ts";

const request = buildContextRequest({
	provider: "synthetic",
	model: "snapshot",
	token: "unused",
	temperature: 0,
	systemPrompt: "system",
	userPrompt: "user",
	responseReserve: 128,
});

test("consultative counterexample: synchronously late count cannot beat an expired deadline timer", async () => {
	const original = syntheticContextAuthority().resolve(request);
	assert.ok(original);
	let aborted = false;
	const authority = syntheticContextAuthority({
		count: async (input, signal) => {
			signal.addEventListener(
				"abort",
				() => {
					aborted = true;
				},
				{ once: true },
			);
			const start = performance.now();
			// Explicit late-settlement fault; no upper elapsed-time assertion or retry.
			while (performance.now() - start < 20) {}
			return original.count(input, signal);
		},
	});
	const result = await admitContext(request, {
		...authority,
		countTimeoutMilliseconds: 5,
	});
	assert.equal(result.status, "COUNTING_UNSUPPORTED");
	assert.equal(aborted, true);
});

test("consultative counterexample: schema-valid incomplete coverage retains one typed structural retry", async () => {
	let coverageError: unknown;
	try {
		assertExactPlanningCoverage(
			[
				{
					commit: {
						type: "fix",
						description: "retain path",
						isBreaking: false,
					},
					files: ["a"],
				},
			],
			["a", "b"],
		);
	} catch (error) {
		coverageError = error;
	}
	assert.ok(coverageError);
	const result = createLlmJobFailure("fixture", coverageError);
	assert("planningFailureKind" in result);
	assert.equal(result.planningFailureKind, "structural");
	assert.equal(
		commitJobResultSchema.safeParse({
			...result,
			providerFailureKind: "rate_limit",
		}).success,
		false,
	);
	const parsed = commitJobResultSchema.parse(result);
	assert.equal(parsed.success, false);
	if (parsed.success) throw new Error("expected failure");
	assert("planningFailureKind" in parsed);
	assert.equal(parsed.planningFailureKind, "structural");
	const f = await fixture();
	retryJobs.length = 0;
	try {
		const options = {
			result: parsed,
			repoState: {
				repository: f.repo.dir,
				status: "RUNNING" as const,
				validatedSource: f.validated.validatedSource,
				diffHash: f.validated.diffHash,
				lastPlanHash: "preserved-real-plan-fingerprint",
			},
			runId: "synthetic-structural",
			settings,
			systemPrompt: "plan",
			skillLog: createSkillStatsLog(),
		};
		const next = handleLlmJobFailure(options);
		assert.equal(next.attempts?.structural, 1);
		assert.equal(retryJobs.length, 1);
		assert.equal(next.lastPlanHash, options.repoState.lastPlanHash);
		const payload = JSON.parse(retryJobs[0]?.prompt ?? "");
		assert.equal(payload.feedback.errors[0].kind, "structural");
		assert.equal(
			handleLlmJobFailure({ ...options, repoState: next }).status,
			"FAILED",
		);
		assert.equal(retryJobs.length, 1);
		assert.equal(git(f.repo.dir, "rev-parse", "HEAD"), f.head);
		assert.equal(git(f.remote, "rev-parse", "HEAD"), f.head);
	} finally {
		retryJobs.length = 0;
		f.dispose();
	}
});

test("consultative counterexample: fullDiffHash binds raw invalid-UTF8 binary patch bytes", async () => {
	const f = await fixture();
	try {
		const witness = f.validated.validatedSource;
		assert.ok(witness.baseHeadSha);
		const raw = execFileSync(
			"git",
			[
				"--no-replace-objects",
				"diff",
				"--patch",
				"--text",
				"--full-index",
				"--no-color",
				"--no-ext-diff",
				"--no-textconv",
				"--no-renames",
				"--ignore-submodules=none",
				"--submodule=short",
				"--src-prefix=a/",
				"--dst-prefix=b/",
				witness.baseHeadSha,
				witness.expectedTreeSha,
				"--",
			],
			{ cwd: f.repo.dir },
		);
		assert(raw.includes(255));
		const hash = (bytes: Uint8Array) =>
			createHash("sha256").update(bytes).digest("hex");
		assert.notEqual(hash(raw), hash(Buffer.from(raw.toString("utf8"))));
		assert.equal(witness.fullDiffHash, hash(raw));
	} finally {
		f.dispose();
	}
});

for (const transition of ["file-to-directory", "directory-to-file"] as const) {
	test(`consultative counterexample: ${transition} path coupling refuses before generation`, async () => {
		const f = await fixture(transition);
		try {
			const t = transport(f);
			await assert.rejects(
				executePlanningJob(f.payload, "synthetic", t.invoke, t.authority),
				/coupled|unsupported/i,
			);
			assert.equal(t.calls.length, 0);
			assert.equal(git(f.repo.dir, "rev-parse", "HEAD"), f.head);
			assert.equal(git(f.remote, "rev-parse", "HEAD"), f.head);
		} finally {
			f.dispose();
		}
	});
}

test("consultative counterexample: synchronously late rejection still aborts the count", async () => {
	let aborted = false;
	const authority = syntheticContextAuthority({
		count: async (_input, signal) => {
			signal.addEventListener(
				"abort",
				() => {
					aborted = true;
				},
				{ once: true },
			);
			const start = performance.now();
			while (performance.now() - start < 20) {}
			throw new Error("synthetic late rejection");
		},
	});
	const result = await admitContext(request, {
		...authority,
		countTimeoutMilliseconds: 5,
	});
	assert.equal(result.status, "COUNTING_UNSUPPORTED");
	assert.equal(aborted, true);
});

test("typed terminal provider diagnostics cannot masquerade as validation retries", async () => {
	const f = await fixture();
	try {
		for (const error of [
			new AuthError({ message: "validation rejected" }),
			new InvalidRequestError({ message: "validation rejected" }),
			new AbortedError({ message: "validation rejected" }),
		]) {
			retryJobs.length = 0;
			const result = commitJobResultSchema.parse(
				createLlmJobFailure("fixture", error),
			);
			assert.equal(result.success, false);
			if (result.success) throw new Error("expected failure");
			const next = handleLlmJobFailure({
				result,
				repoState: {
					repository: f.repo.dir,
					status: "RUNNING",
					validatedSource: f.validated.validatedSource,
					diffHash: f.validated.diffHash,
				},
				runId: "synthetic-terminal",
				settings: {
					...settings,
					fallbackProvider: "mistral",
					fallbackModel: "synthetic-small",
				},
				systemPrompt: "plan",
				skillLog: createSkillStatsLog(),
			});
			assert.equal(next.status, "FAILED");
			assert.equal(retryJobs.length, 0);
			assert.equal(next.attempts?.validation, undefined);
			assert.equal(next.fallbackAttempted, undefined);
		}
	} finally {
		retryJobs.length = 0;
		f.dispose();
	}
});

for (const fingerprint of [undefined, "genuine-prior-plan"]) {
	test(`consultative counterexample: provider outage preserves ${fingerprint ?? "absent"} fingerprint`, async () => {
		const f = await fixture();
		retryJobs.length = 0;
		try {
			const next = handleLlmJobFailure({
				result: createLlmJobFailure("fixture", new RateLimitError()),
				repoState: {
					repository: f.repo.dir,
					status: "RUNNING",
					validatedSource: f.validated.validatedSource,
					diffHash: f.validated.diffHash,
					lastPlanHash: fingerprint,
				},
				runId: "synthetic-provider",
				settings: {
					...settings,
					provider: "google",
					fallbackProvider: "mistral",
					fallbackModel: "synthetic-small",
				},
				systemPrompt: "plan",
				skillLog: createSkillStatsLog(),
			});
			assert.equal(next.lastPlanHash, fingerprint);
			assert.equal(next.fallbackAttempted, true);
			assert.equal(next.attempts?.provider, 1);
			assert.equal(retryJobs.length, 1);
		} finally {
			retryJobs.length = 0;
			f.dispose();
		}
	});
}
