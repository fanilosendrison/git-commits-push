import assert from "node:assert/strict";
import test from "node:test";
import {
	buildSimplePrompt,
	createOpenAICompatibleAdapter,
} from "@fanilosendrison/llm-runtime";
import { collectCommitMessageValidationErrors } from "../../src/modules/core/commit-message-validation.ts";
import { handleLlmJobFailure } from "../../src/modules/core/llm-job-failure-handler.ts";
import { retryJobs } from "../../src/modules/core/queue-retry.ts";
import { ContextAdmissionError } from "../../src/modules/llm/context-admission.ts";
import {
	invokeLlm,
	type LlmAdapterFactories,
} from "../../src/modules/llm/llm-invoker.ts";
import { PlanningAttemptBudget } from "../../src/modules/llm/planning-attempt-budget.ts";
import { createSkillStatsLog } from "../../src/modules/telemetry/stats-logger.ts";
import type {
	CommitMessageRepairPayload,
	CommitPlan,
} from "../../src/types.ts";
import {
	fixture,
	fixtureBridge,
	git,
	settings,
	transport,
} from "../fixtures/context-planning.ts";
import { syntheticContextAuthority } from "../helpers/context-authority.ts";

/** Real runtime, deterministic HTTP; preserve a production-installed transport guard. */
function factories(
	fetch: typeof globalThis.fetch,
	authority = syntheticContextAuthority(),
): LlmAdapterFactories {
	const unexpected = () => {
		throw new Error("Unexpected provider");
	};
	return {
		buildSimplePrompt,
		fetch,
		contextAuthority: authority,
		createAnthropicAdapter: unexpected,
		createGoogleAdapter: unexpected,
		createOpenAIAdapter: unexpected,
		createOpenAICompatibleAdapter: (config) =>
			createOpenAICompatibleAdapter({
				...config,
				retry: {
					maxAttempts: config.retry?.maxAttempts ?? 1,
					backoffBaseMs: 0,
					maxBackoffMs: 0,
				},
				providerOptions: {
					...(config.providerOptions as Record<string, unknown>),
					fetch:
						(
							config.providerOptions as
								| { fetch?: typeof globalThis.fetch }
								| undefined
						)?.fetch ?? fetch,
				},
			}),
	};
}

test("expired proof blocks an actual SDK retry before its next HTTP send", async () => {
	let now = 100;
	let sent = 0;
	const authority = { ...syntheticContextAuthority(), now: () => now };
	const fetch: typeof globalThis.fetch = async () => {
		sent++;
		now = 2000;
		return new Response(
			JSON.stringify({ error: { message: "synthetic overload" } }),
			{ status: 503 },
		);
	};
	await assert.rejects(
		invokeLlm(
			{
				provider: "mistral",
				model: "synthetic-snapshot",
				token: "synthetic",
				userPrompt: "synthetic bounded request",
				systemPrompt: "test",
				temperature: 0,
			},
			factories(fetch, authority),
			new PlanningAttemptBudget(),
		),
		(error) =>
			error instanceof ContextAdmissionError &&
			error.status === "CAPABILITY_STALE",
	);
	assert.equal(sent, 1);
});

test("actual repair outage and fallback retain every requested index and frozen ownership", async () => {
	const f = await fixture();
	try {
		retryJobs.length = 0;
		const paths = f.validated.validatedSource.expectedChangedPaths;
		const plans: CommitPlan[] = [0, 1, 2].map((index) => ({
			commit: {
				type: "fix",
				description:
					index < 2
						? "preserve bounded exact repair ".repeat(5)
						: "preserve valid ownership",
				isBreaking: false,
				body: `frozen body ${index}`,
			},
			files: index < 2 ? paths.slice(index, index + 1) : paths.slice(2),
		}));
		const errors = collectCommitMessageValidationErrors(plans);
		assert.deepEqual(
			errors.map((error) => error.planIndex),
			[0, 1],
		);
		const payload: CommitMessageRepairPayload = {
			...f.payload,
			mode: "repair-commit-messages",
			rejectedPlans: plans,
			validationErrors: errors,
		};
		let primarySends = 0;
		let fallbackSends = 0;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			if (typeof init?.body !== "string") throw new Error("Expected JSON body");
			const body = JSON.parse(init.body);
			if (body.model !== "synthetic-fallback") {
				primarySends++;
				return new Response(
					JSON.stringify({ error: { message: "synthetic rate limit" } }),
					{ status: 429 },
				);
			}
			fallbackSends++;
			return new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: JSON.stringify(
									[0, 1].map((planIndex) => {
										const plan = plans[planIndex];
										assert.ok(plan);
										return {
											planIndex,
											commit: {
												...plan.commit,
												description: "retain exact frozen repair",
											},
										};
									}),
								),
							},
							finish_reason: "stop",
						},
					],
				}),
				{ status: 200 },
			);
		};
		const dependencies = factories(fetch);
		assert.ok(dependencies.contextAuthority);
		const bridge = {
			...transport(f),
			authority: dependencies.contextAuthority,
			invoke: ((input, _unused, budget) =>
				invokeLlm(input, dependencies, budget)) as typeof invokeLlm,
		};
		const failed = await fixtureBridge(f, bridge, payload, "repair-primary");
		assert.equal(failed.success, false);
		if (failed.success) throw new Error("Expected primary failure");
		assert.equal(failed.providerFailureKind, "rate_limit");
		assert.equal(primarySends, 5);
		assert.deepEqual(failed.rejectedPlans, plans);
		const next = handleLlmJobFailure({
			result: failed,
			repoState: {
				repository: f.repo.dir,
				status: "RUNNING",
				validatedSource: f.validated.validatedSource,
				diffHash: f.validated.diffHash,
				attempts: { validation: 1 },
			},
			runId: "synthetic-repair",
			settings: {
				...settings,
				fallbackProvider: "mistral",
				fallbackModel: "synthetic-fallback",
			},
			systemPrompt: "test",
			skillLog: createSkillStatsLog(),
		});
		assert.equal(retryJobs.length, 1);
		const job = retryJobs[0];
		assert.ok(job);
		const queued = JSON.parse(job.prompt) as CommitMessageRepairPayload;
		assert.deepEqual(queued.validationErrors, errors);
		assert.deepEqual(queued.rejectedPlans, plans);
		const repaired = await fixtureBridge(f, bridge, queued, "repair-fallback");
		assert.equal(repaired.success, true);
		if (!repaired.success) throw new Error("Expected successful fallback");
		assert.equal(fallbackSends, 1);
		assert.equal(next.fallbackAttempted, true);
		assert.equal(next.attempts?.provider, 1);
		assert.equal(next.attempts?.validation, 1);
		assert.deepEqual(
			repaired.commits.map((plan) => plan.files),
			plans.map((plan) => plan.files),
		);
		assert.deepEqual(
			repaired.commits.map((plan) => plan.commit.body),
			plans.map((plan) => plan.commit.body),
		);
		assert.deepEqual(repaired.commits[2], plans[2]);
		assert.deepEqual(
			collectCommitMessageValidationErrors(repaired.commits),
			[],
		);
		assert.equal(git(f.repo.dir, "rev-parse", "HEAD"), f.head);
	} finally {
		retryJobs.length = 0;
		f.dispose();
	}
});
