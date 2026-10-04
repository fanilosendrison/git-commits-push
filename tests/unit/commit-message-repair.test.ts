import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { parseCommitJobResponse } from "../../src/modules/core/commit-job-response.ts";
import {
	formatCommitMessageRepairPrompt,
	mergeCommitMessageRepairs,
} from "../../src/modules/core/commit-message-repair.ts";
import { collectCommitMessageValidationErrors } from "../../src/modules/core/commit-message-validation.ts";
import { queueRetry, retryJobs } from "../../src/modules/core/queue-retry.ts";
import {
	MAX_COMMIT_SUBJECT_LENGTH,
	validateCommitMessage,
} from "../../src/modules/core/validators/commit-message-validator.ts";
import { formatConventionalCommit } from "../../src/modules/formatters/commit-formatter.ts";
import type {
	CommitMessage,
	CommitMessageRepairPayload,
	CommitPlanningPayload,
	FeedbackError,
	Settings,
} from "../../src/types.ts";

const THIRTY_THREE_CHARACTER_BUDGET_SCOPE = "repository-governance-bootstrap";

function repairFirstPlan(
	payload: CommitMessageRepairPayload,
	description: string,
	overrides: Partial<CommitMessage> = {},
) {
	const rejected = payload.rejectedPlans[0]?.commit;
	assert.ok(rejected);
	return mergeCommitMessageRepairs(payload, [
		{
			planIndex: 0,
			commit: { ...rejected, ...overrides, description },
		},
	]);
}

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
		assert.strictEqual(body.plans[0].subjectPrefix, "feat: ");
		assert.strictEqual(body.plans[0].maximumDescriptionLength, 66);
		assert.deepStrictEqual(
			body.plans.map((plan: { planIndex: number }) => plan.planIndex),
			[0],
		);
		assert.ok(!prompt.includes("src/feature.ts"));
	});

	test("provides the exact description budget for a long protected scope", () => {
		const payload = makePayload();
		const firstPlan = payload.rejectedPlans[0];
		assert.ok(firstPlan);
		firstPlan.commit.scope = "github-authoritative-ref-monotonicity";

		const prompt = formatCommitMessageRepairPrompt(payload);
		const body = JSON.parse(prompt);

		assert.strictEqual(
			body.plans[0].subjectPrefix,
			"feat(github-authoritative-ref-monotonicity): ",
		);
		assert.strictEqual(body.plans[0].maximumDescriptionLength, 27);
	});

	test("accepts a long-scope repair inside the calculated budget", () => {
		const payload = makePayload();
		const firstPlan = payload.rejectedPlans[0];
		assert.ok(firstPlan);
		firstPlan.commit.scope = "github-authoritative-ref-monotonicity";

		const merged = mergeCommitMessageRepairs(payload, [
			{
				planIndex: 0,
				commit: {
					type: "feat",
					scope: "github-authoritative-ref-monotonicity",
					description: "use system trust for TLS",
					isBreaking: false,
				},
			},
		]);

		assert.strictEqual(
			merged[0]?.commit.description,
			"use system trust for TLS",
		);
	});

	test("preserves an in-budget repair description exactly", () => {
		const payload = makePayload();
		const description = "observe  resolved bootstrap";
		assert.strictEqual(
			repairFirstPlan(payload, description)[0]?.commit.description,
			description,
		);
	});

	test("fits the concrete 34/33 repair at its last whole-word boundary", () => {
		const payload = makePayload();
		const rejected = payload.rejectedPlans[0]?.commit;
		assert.ok(rejected);
		rejected.scope = THIRTY_THREE_CHARACTER_BUDGET_SCOPE;
		const prompt = JSON.parse(formatCommitMessageRepairPrompt(payload));
		assert.strictEqual(
			prompt.plans[0].maximumDescriptionLength,
			MAX_COMMIT_SUBJECT_LENGTH - prompt.plans[0].subjectPrefix.length,
		);
		assert.strictEqual(prompt.plans[0].maximumDescriptionLength, 33);
		assert.strictEqual("observe resolved bootstrap targets".length, 34);
		assert.strictEqual(
			repairFirstPlan(payload, "observe resolved bootstrap targets")[0]?.commit
				.description,
			"observe resolved bootstrap",
		);
	});

	test("accepts an ASCII-space boundary exactly at the maximum", () => {
		const payload = makePayload();
		const rejected = payload.rejectedPlans[0]?.commit;
		assert.ok(rejected);
		rejected.scope = THIRTY_THREE_CHARACTER_BUDGET_SCOPE;
		const exactPrefix = "a".repeat(33);
		assert.strictEqual(
			repairFirstPlan(payload, `${exactPrefix} overflow`)[0]?.commit
				.description,
			exactPrefix,
		);
	});

	test("selects the longest fitting prefix and preserves multiple spaces", () => {
		const payload = makePayload();
		const rejected = payload.rejectedPlans[0]?.commit;
		assert.ok(rejected);
		rejected.scope = THIRTY_THREE_CHARACTER_BUDGET_SCOPE;
		assert.strictEqual(
			repairFirstPlan(payload, "observe  resolved bootstrap targets now")[0]
				?.commit.description,
			"observe  resolved bootstrap",
		);
	});

	test("fails closed rather than splitting the first word", () => {
		const payload = makePayload();
		const rejected = payload.rejectedPlans[0]?.commit;
		assert.ok(rejected);
		rejected.scope = THIRTY_THREE_CHARACTER_BUDGET_SCOPE;
		assert.throws(
			() => repairFirstPlan(payload, "a".repeat(34)),
			/no whole-word prefix fits/u,
		);
	});

	test("does not treat tabs or Unicode whitespace as word boundaries", () => {
		const payload = makePayload();
		const rejected = payload.rejectedPlans[0]?.commit;
		assert.ok(rejected);
		rejected.scope = THIRTY_THREE_CHARACTER_BUDGET_SCOPE;
		for (const separator of ["\t", "\n", "\u00a0"]) {
			assert.throws(
				() =>
					repairFirstPlan(
						payload,
						`${"a".repeat(20)}${separator}${"b".repeat(20)}`,
					),
				/no whole-word prefix fits/u,
			);
		}
	});

	test("fitting preserves protected fields, body, files, and plan shape", () => {
		const payload = makePayload();
		const rejected = payload.rejectedPlans[0]?.commit;
		assert.ok(rejected);
		rejected.scope = THIRTY_THREE_CHARACTER_BUDGET_SCOPE;
		rejected.isBreaking = true;
		const body = "Exact body bytes\nremain here.";
		const merged = repairFirstPlan(
			payload,
			"observe resolved bootstrap targets",
			{ body },
		);
		assert.strictEqual(merged.length, payload.rejectedPlans.length);
		assert.deepStrictEqual(merged[0]?.files, ["src/feature.ts"]);
		assert.deepStrictEqual(merged[1], payload.rejectedPlans[1]);
		assert.notStrictEqual(merged[0]?.files, payload.rejectedPlans[0]?.files);
		assert.deepStrictEqual(merged[0]?.commit, {
			type: "feat",
			scope: THIRTY_THREE_CHARACTER_BUDGET_SCOPE,
			description: "observe resolved bootstrap",
			body,
			isBreaking: true,
		});
	});

	test("the canonical validator accepts a valid fitted repair", () => {
		const payload = makePayload();
		const rejected = payload.rejectedPlans[0]?.commit;
		assert.ok(rejected);
		rejected.scope = THIRTY_THREE_CHARACTER_BUDGET_SCOPE;
		const commit = repairFirstPlan(
			payload,
			"observe resolved bootstrap targets",
		)[0]?.commit;
		assert.ok(commit);
		assert.deepStrictEqual(
			validateCommitMessage(formatConventionalCommit(commit)).errors,
			[],
		);
	});

	test("the canonical validator still rejects another invalid rule", () => {
		const payload = makePayload();
		const rejected = payload.rejectedPlans[0]?.commit;
		assert.ok(rejected);
		rejected.scope = THIRTY_THREE_CHARACTER_BUDGET_SCOPE;
		const commit = repairFirstPlan(
			payload,
			"implementing bootstrap observation safely",
		)[0]?.commit;
		assert.ok(commit);
		assert.match(
			validateCommitMessage(formatConventionalCommit(commit)).errors.join(" "),
			/gérondif/u,
		);
	});

	test("initial planning remains over-budget until ordinary validation", () => {
		const payload: CommitPlanningPayload = {
			repository: "/repo",
			diffHash: "abc123",
			provider: "mistral",
			model: "mistral-medium-3.5",
			temperature: 0,
			systemPrompt: "planning",
			diff: "diff",
		};
		const description = "a".repeat(MAX_COMMIT_SUBJECT_LENGTH);
		const plans = parseCommitJobResponse(
			payload,
			JSON.stringify([
				{
					commit: { type: "feat", description, isBreaking: false },
					files: ["src/feature.ts"],
				},
			]),
		);
		assert.strictEqual(plans[0]?.commit.description, description);
		assert.deepStrictEqual(
			collectCommitMessageValidationErrors(plans).map((error) => error.rule),
			["subject-max-length"],
		);
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
