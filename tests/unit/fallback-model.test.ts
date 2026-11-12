/**
 * tests/unit/fallback-model.test.ts — Tests for fallback model escalation
 *
 * When the default model exhausts its validation budget, the skill should
 * retry with a fallback model before failing.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	ProviderProtocolError,
	RateLimitError,
	TimeoutError,
	TransientProviderError,
} from "@fanilosendrison/llm-runtime";
import {
	commitJobResultSchema,
	stateSchema,
} from "../../src/config/state-schema.ts";
import {
	buildFallbackSettings,
	shouldUseFallback,
} from "../../src/modules/core/fallback-model.ts";
import { handleLlmJobFailure } from "../../src/modules/core/llm-job-failure-handler.ts";
import { retryJobs } from "../../src/modules/core/queue-retry.ts";
import { createLlmJobFailure } from "../../src/modules/llm/provider-failure.ts";
import { createSkillStatsLog } from "../../src/modules/telemetry/stats-logger.ts";
import type { RepoState, Settings } from "../../src/types.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";

const BASE_SETTINGS: Settings = {
	searchPaths: [],
	provider: "deepseek",
	model: "deepseek-v4-flash",
	temperature: 0,
	systemPromptPath: "/dev/null",
	autoPush: false,
	skipTests: true,
};

describe("shouldUseFallback", () => {
	test("returns false when no fallback configured", () => {
		const result = shouldUseFallback(
			BASE_SETTINGS,
			"validation",
			2, // max reached
			false, // not yet attempted
		);
		assert.strictEqual(result, false);
	});

	test("returns false when attempt count < max", () => {
		const settings = {
			...BASE_SETTINGS,
			fallbackProvider: "openai",
			fallbackModel: "gpt-5.5",
		};
		const result = shouldUseFallback(settings, "validation", 1, false);
		assert.strictEqual(result, false);
	});

	test("returns false when fallback already attempted", () => {
		const settings = {
			...BASE_SETTINGS,
			fallbackProvider: "openai",
			fallbackModel: "gpt-5.5",
		};
		const result = shouldUseFallback(settings, "validation", 2, true);
		assert.strictEqual(result, false);
	});

	test("returns true when max reached and fallback available and not yet attempted", () => {
		const settings = {
			...BASE_SETTINGS,
			fallbackProvider: "openai",
			fallbackModel: "gpt-5.5",
		};
		const result = shouldUseFallback(settings, "validation", 2, false);
		assert.strictEqual(result, true);
	});

	test("only applies to validation kind (not structural/race/etc)", () => {
		const settings = {
			...BASE_SETTINGS,
			fallbackProvider: "openai",
			fallbackModel: "gpt-5.5",
		};
		assert.strictEqual(
			shouldUseFallback(settings, "structural", 1, false),
			false,
		);
		assert.strictEqual(shouldUseFallback(settings, "race", 1, false), false);
		assert.strictEqual(shouldUseFallback(settings, "git", 1, false), false);
		assert.strictEqual(shouldUseFallback(settings, "network", 1, false), false);
	});
});

test("typed outage crosses durable schema and queues Mistral once on a real pending diff", () => {
	const repo = GitRepoFixture.create();
	const settings: Settings = {
		...BASE_SETTINGS,
		provider: "google",
		model: "gemini-3.5-flash-lite",
		fallbackProvider: "mistral",
		fallbackModel: "mistral-large-latest",
	};
	try {
		repo.commit("baseline");
		repo.writeAndStage("change.txt", "pending change\n");
		for (const error of [
			new RateLimitError(),
			new TransientProviderError({ status: 503 }),
			new TimeoutError(),
			new ProviderProtocolError(),
		]) {
			retryJobs.length = 0;
			const result = commitJobResultSchema.parse(
				createLlmJobFailure("repo", error),
			);
			assert.equal(result.success, false);
			if (result.success) throw new Error("expected failure");
			const options = {
				result,
				repoState: {
					repository: repo.dir,
					status: "PENDING",
					diffHash: "initial",
				} as RepoState,
				settings,
				runId: "test",
				systemPrompt: "plan",
				skillLog: createSkillStatsLog(),
			};
			const next = handleLlmJobFailure(options);
			assert.deepEqual(
				stateSchema.parse({ repos: { repo: next } }).repos.repo,
				next,
			);
			assert.equal(next.fallbackAttempted, true);
			assert.equal(next.attempts?.provider, 1);
			assert.equal(retryJobs.length, 1);
			const queued = retryJobs[0];
			assert.ok(queued);
			const payload = JSON.parse(queued.prompt);
			assert.equal(payload.provider, "mistral");
			assert.equal(payload.model, "mistral-large-latest");
			assert.ok(payload.diff.includes("pending change"));
			const terminal = handleLlmJobFailure({ ...options, repoState: next });
			assert.equal(terminal.status, "FAILED");
			assert.equal(retryJobs.length, 1);
		}
		retryJobs.length = 0;
		const rejectedPlans = [
			{
				commit: {
					type: "feat",
					description:
						"repair this subject while retaining exact ownership ".repeat(3),
					isBreaking: false,
				},
				files: ["change.txt"],
			},
		];
		handleLlmJobFailure({
			result: {
				...createLlmJobFailure("repo", new RateLimitError()),
				rejectedPlans,
			},
			repoState: {
				repository: repo.dir,
				status: "PENDING",
				diffHash: "original",
				lastPlanHash: "previous-repair",
			},
			settings,
			runId: "repair",
			systemPrompt: "plan",
			skillLog: createSkillStatsLog(),
		});
		const repair = retryJobs[0];
		assert.ok(repair);
		const payload = JSON.parse(repair.prompt);
		assert.equal(payload.mode, "repair-commit-messages");
		assert.deepEqual(payload.rejectedPlans, rejectedPlans);
		assert.equal(payload.validationErrors[0].planIndex, 0);
		assert.equal(payload.provider, "mistral");
		repo.commit("consume pending change");
		assert.throws(
			() =>
				handleLlmJobFailure({
					result: createLlmJobFailure("repo", new RateLimitError()),
					repoState: {
						repository: repo.dir,
						status: "PENDING",
						diffHash: "old",
					},
					settings,
					runId: "test",
					systemPrompt: "plan",
					skillLog: createSkillStatsLog(),
				}),
			/no remaining diff/,
		);
	} finally {
		retryJobs.length = 0;
		repo.dispose();
	}
});

describe("buildFallbackSettings", () => {
	test("returns settings with fallback provider/model", () => {
		const settings = {
			...BASE_SETTINGS,
			fallbackProvider: "openai",
			fallbackModel: "gpt-5.5",
		};

		const result = buildFallbackSettings(settings);

		assert.strictEqual(result.provider, "openai");
		assert.strictEqual(result.model, "gpt-5.5");
	});

	test("preserves other settings fields", () => {
		const settings = {
			...BASE_SETTINGS,
			fallbackProvider: "anthropic",
			fallbackModel: "claude-sonnet-4",
		};

		const result = buildFallbackSettings(settings);

		assert.strictEqual(result.temperature, 0);
		assert.strictEqual(result.autoPush, false);
	});
});
