import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
	formatCommitMessageRepairPrompt,
	mergeCommitMessageRepairs,
} from "../../src/modules/core/commit-message-repair.ts";
import { queueRetry, retryJobs } from "../../src/modules/core/queue-retry.ts";
import type {
	CommitMessageRepairPayload,
	FeedbackError,
	Settings,
} from "../../src/types.ts";

function makePayload(): CommitMessageRepairPayload {
	return {
		mode: "repair-commit-messages",
		repository: "/repo",
		diffHash: "abc123",
		provider: "mistral",
		model: "mistral-medium-3.5",
		temperature: 0,
		systemPrompt: "ignored for repair",
		rejectedPlans: [
			{
				commit: {
					type: "feat",
					description: "an excessively detailed feature description",
					isBreaking: false,
				},
				files: ["src/feature.ts"],
			},
			{
				commit: {
					type: "test",
					description: "keep valid coverage",
					isBreaking: false,
				},
				files: ["tests/feature.test.ts"],
			},
		],
		validationErrors: [
			{
				kind: "validation",
				message: "Subject line trop long",
				planIndex: 0,
				rule: "subject-max-length",
				rejectedSubject: "feat: an excessively detailed feature description",
				actualLength: 80,
				maximumLength: 72,
			},
		],
	};
}

afterEach(() => {
	retryJobs.length = 0;
});

describe("commit-message repair protocol", () => {
	test("queues a compact validation payload without reconstructing the diff", () => {
		const source = makePayload();
		const settings: Settings = {
			searchPaths: [],
			provider: source.provider,
			model: source.model,
			temperature: source.temperature,
			systemPromptPath: "/dev/null",
			autoPush: false,
			skipTests: true,
		};
		const result = queueRetry(
			"repo-id",
			{
				repository: source.repository,
				status: "RUNNING",
				diffHash: source.diffHash,
			},
			source.validationErrors as FeedbackError[],
			{},
			settings,
			source.systemPrompt,
			source.rejectedPlans,
		);
		assert.strictEqual(result.kind, "queued");
		if (result.kind !== "queued") return;
		const payload = JSON.parse(result.job.prompt);
		assert.strictEqual(payload.mode, "repair-commit-messages");
		assert.strictEqual(payload.diff, undefined);
		assert.deepStrictEqual(payload.rejectedPlans, source.rejectedPlans);
	});

	test("formats only rejected plans, indexed errors, and the canonical limit", () => {
		const prompt = formatCommitMessageRepairPrompt(makePayload());
		const body = JSON.parse(prompt);
		assert.strictEqual(body.task, "repair-commit-messages");
		assert.strictEqual(body.maximumSubjectLength, 72);
		assert.deepStrictEqual(
			body.plans.map((plan: { planIndex: number }) => plan.planIndex),
			[0],
		);
		assert.ok(!prompt.includes("src/feature.ts"));
	});

	test("merges indexed messages while preserving every original file list", () => {
		const payload = makePayload();
		const merged = mergeCommitMessageRepairs(payload, [
			{
				planIndex: 0,
				commit: {
					type: "feat",
					description: "add focused feature",
					isBreaking: false,
				},
			},
		]);
		assert.deepStrictEqual(merged[0]?.files, ["src/feature.ts"]);
		assert.deepStrictEqual(merged[1], payload.rejectedPlans[1]);
		assert.notStrictEqual(merged[0]?.files, payload.rejectedPlans[0]?.files);
	});

	test("rejects repairs that change semantic commit fields", () => {
		const payload = makePayload();
		for (const commit of [
			{
				type: "chore",
				description: "repair the subject",
				isBreaking: false,
			},
			{
				type: "feat",
				scope: "hijacked-scope",
				description: "repair the subject",
				isBreaking: false,
			},
			{
				type: "feat",
				description: "repair the subject",
				isBreaking: true,
			},
		]) {
			assert.throws(
				() => mergeCommitMessageRepairs(payload, [{ planIndex: 0, commit }]),
				/semantic fields/u,
			);
		}
	});

	test("rejects missing, duplicate, unexpected, or file-bearing repairs", () => {
		const payload = makePayload();
		const commit = {
			type: "feat",
			description: "add focused feature",
			isBreaking: false,
		};
		for (const response of [
			[],
			[
				{ planIndex: 0, commit },
				{ planIndex: 0, commit },
			],
			[{ planIndex: 1, commit }],
			[{ planIndex: 0, commit, files: ["model-controlled.ts"] }],
		]) {
			assert.throws(() => mergeCommitMessageRepairs(payload, response));
		}
	});
});
