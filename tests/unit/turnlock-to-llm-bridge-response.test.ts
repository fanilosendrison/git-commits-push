import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
	AbortedError,
	AuthError,
	InvalidRequestError,
	OverloadedError,
	ProviderProtocolError,
	RateLimitError,
	ResponseParseError,
	TimeoutError,
	TransientProviderError,
} from "@fanilosendrison/llm-runtime";
import {
	type BridgeDependencies,
	handleTurnlockDelegation,
} from "../../src/entrypoints/turnlock-to-llm-bridge.ts";
import type {
	CommitJobPayload,
	CommitMessageRepairPayload,
	CommitPlanningPayload,
} from "../../src/types.ts";
import { syntheticContextAuthority } from "../helpers/context-authority.ts";

const cleanup: string[] = [];

function createRepairPayload(): CommitMessageRepairPayload {
	return {
		mode: "repair-commit-messages",
		repository: "/repo",
		diffHash: "diff-hash",
		provider: "mistral",
		model: "mistral-medium-3.5",
		temperature: 0,
		systemPrompt: "unused for compact repair",
		rejectedPlans: [
			{
				commit: {
					type: "feat",
					description:
						"an intentionally overlong commit description requiring repair",
					isBreaking: false,
				},
				files: ["owned.ts"],
			},
		],
		validationErrors: [
			{
				kind: "validation",
				message: "subject too long",
				planIndex: 0,
				rule: "subject-max-length",
				maximumLength: 72,
			},
		],
	};
}

function createPlanningPayload(): CommitPlanningPayload {
	return {
		repository: "/repo",
		diff: "diff --git a/owned.ts b/owned.ts",
		diffHash: "diff-hash",
		provider: "mistral",
		model: "mistral-medium-3.5",
		temperature: 0,
		systemPrompt: "plan commits",
	};
}

function createManifest(resultPath: string, payload: CommitJobPayload) {
	const emittedAtEpochMs = Date.now();
	return {
		manifestVersion: 2,
		runId: "run-response",
		orchestratorName: "git-commits-push-tl",
		phase: "commit-and-push",
		resumeAt: "commit-and-push",
		label: "commit-jobs-retry",
		kind: "batch",
		emittedAt: new Date(emittedAtEpochMs).toISOString(),
		emittedAtEpochMs,
		timeoutMs: 600_000,
		deadlineAtEpochMs: emittedAtEpochMs + 600_000,
		attempt: 0,
		maxAttempts: 1,
		worker: "git-commit-generator",
		jobs: [{ id: "repo", prompt: JSON.stringify(payload), resultPath }],
	};
}

function validRepair(description = "repair the commit subject") {
	return [
		{
			planIndex: 0,
			commit: {
				type: "feat",
				description,
				isBreaking: false,
			},
		},
	];
}

async function runResponses(
	payload: CommitJobPayload,
	responses: readonly unknown[],
) {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-response-"));
	cleanup.push(tempDir);
	const manifestPath = path.join(tempDir, "manifest.json");
	const resultPath = path.join(tempDir, "result.json");
	fs.writeFileSync(
		manifestPath,
		JSON.stringify(createManifest(resultPath, payload)),
	);
	let invocationCount = 0;
	let resumeCount = 0;
	const invocations: Array<Parameters<BridgeDependencies["invokeLlm"]>[0]> = [];
	const dependencies: BridgeDependencies = {
		contextAuthority: syntheticContextAuthority(),
		resolveAuthToken: async () => "token",
		invokeLlm: async (invocation) => {
			invocations.push(invocation);
			const response = responses[invocationCount];
			invocationCount += 1;
			if (response instanceof Error) throw response;
			return JSON.stringify(response);
		},
	};

	await handleTurnlockDelegation(
		manifestPath,
		"resume command",
		() => {
			resumeCount += 1;
			return "";
		},
		dependencies,
	);
	return {
		invocationCount,
		invocations,
		resumeCount,
		result: JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
			success: boolean;
			error?: string;
			providerFailureKind?: string;
			rejectedPlans?: CommitMessageRepairPayload["rejectedPlans"];
			commits?: Array<{
				commit: { description: string; isBreaking: boolean };
				files: string[];
			}>;
		},
	};
}

test("typed provider outages survive the bridge without retrying inference locally", async () => {
	for (const error of [
		new RateLimitError(),
		new TransientProviderError({ status: 503 }),
		new OverloadedError(),
		new TimeoutError(),
		new ProviderProtocolError(),
		new ResponseParseError(),
	]) {
		const outcome = await runResponses(createPlanningPayload(), [error]);
		assert.equal(outcome.invocationCount, 1);
		assert.equal(outcome.result.success, false);
		assert.equal(outcome.result.providerFailureKind, error.kind);
	}
	const repair = createRepairPayload();
	const failedRepair = await runResponses(repair, [new RateLimitError()]);
	assert.deepEqual(failedRepair.result.rejectedPlans, repair.rejectedPlans);
	for (const error of [
		new AuthError(),
		new InvalidRequestError(),
		new AbortedError(),
		new Error("HTTP 503"),
	]) {
		const outcome = await runResponses(createPlanningPayload(), [error]);
		assert.equal(outcome.result.providerFailureKind, undefined);
	}
});

afterEach(() => {
	for (const directory of cleanup.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("compact commit-message repair bridge retries", () => {
	test("retries a schema-invalid array and accepts a valid second repair", async () => {
		const invalidRepair = validRepair("attempted file takeover").map(
			(entry) => ({
				...entry,
				files: ["hijacked.ts"],
			}),
		);
		const execution = await runResponses(createRepairPayload(), [
			invalidRepair,
			validRepair("repair the subject safely"),
		]);

		assert.strictEqual(execution.invocationCount, 2);
		assert.strictEqual(execution.resumeCount, 1);
		assert.strictEqual(execution.result.success, true);
		assert.strictEqual(
			execution.result.commits?.[0]?.commit.description,
			"repair the subject safely",
		);
		assert.deepStrictEqual(execution.result.commits?.[0]?.files, ["owned.ts"]);
	});

	test("terminates after exactly two schema-invalid repair arrays", async () => {
		const execution = await runResponses(createRepairPayload(), [
			[{ planIndex: 0, commit: { type: "feat", description: "missing flag" } }],
			[...validRepair("duplicate one"), ...validRepair("duplicate two")],
		]);

		assert.strictEqual(execution.invocationCount, 2);
		assert.strictEqual(execution.resumeCount, 1);
		assert.strictEqual(execution.result.success, false);
		assert.match(execution.result.error ?? "", /LLM Fatal Error/u);
	});
});

describe("planning response bridge retries", () => {
	test("forwards configured thinking to every provider invocation", async () => {
		const execution = await runResponses(
			{ ...createPlanningPayload(), thinking: true },
			[
				[{ unexpected: "shape" }],
				[
					{
						commit: { type: "feat", description: "add the feature" },
						files: ["owned.ts"],
					},
				],
			],
		);

		assert.strictEqual(execution.invocationCount, 2);
		assert.strictEqual(
			execution.invocations.every(({ thinking }) => thinking === true),
			true,
		);
	});

	test("persists only sanitized provider failures", async () => {
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "bridge-secret-error-"),
		);
		cleanup.push(tempDir);
		const manifestPath = path.join(tempDir, "manifest.json");
		const resultPath = path.join(tempDir, "result.json");
		fs.writeFileSync(
			manifestPath,
			JSON.stringify(createManifest(resultPath, createPlanningPayload())),
		);
		const secret = "provider-secret-value";
		let loggedError = "";
		const originalConsoleError = console.error;
		console.error = (...values: unknown[]) => {
			loggedError += values.map(String).join(" ");
		};
		try {
			await handleTurnlockDelegation(manifestPath, "resume command", () => "", {
				resolveAuthToken: async () => {
					throw new Error(
						`Authorization: Bearer ${secret}\nhttps://user:${secret}@example.invalid/repo`,
					);
				},
				invokeLlm: async () => "unreachable",
			});
		} finally {
			console.error = originalConsoleError;
		}
		const result = fs.readFileSync(resultPath, "utf8");
		assert.strictEqual(result.includes(secret), false);
		assert.strictEqual(loggedError.includes(secret), false);
		assert.match(result, /<redacted>/u);
	});

	test("retries a malformed plan and normalizes a valid second response", async () => {
		const execution = await runResponses(createPlanningPayload(), [
			[{ unexpected: "shape" }],
			[
				{
					commit: { type: "feat", description: "add the feature" },
					files: ["owned.ts"],
				},
			],
		]);

		assert.strictEqual(execution.invocationCount, 2);
		assert.strictEqual(execution.result.success, true);
		assert.strictEqual(execution.result.commits?.[0]?.commit.isBreaking, false);
		assert.deepStrictEqual(execution.result.commits?.[0]?.files, ["owned.ts"]);
	});
});
