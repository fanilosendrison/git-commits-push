// tests/unit/pi-orch-git-commits-push.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

// Set up module mocks before importing the target wrapper
let lastExecCmd: string | null = null;
let lastUserPrompt: string | null = null;
let lastAgentPassed: string | undefined;

interface MockCallArgs {
	readonly temperature: number;
	readonly messages: { user: string };
}

interface TurnlockBatchManifestJobFixture {
	readonly id: string;
	readonly prompt: string;
	readonly resultPath: string;
}

function createTurnlockV2BatchManifest(args: {
	readonly phase: string;
	readonly resumeAt: string;
	readonly label: string;
	readonly jobs: readonly TurnlockBatchManifestJobFixture[];
}) {
	const emittedAtEpochMs = 1_768_000_000_000;
	return {
		manifestVersion: 2 as const,
		runId: "run-123",
		orchestratorName: "git-commits-push-tl",
		phase: args.phase,
		resumeAt: args.resumeAt,
		label: args.label,
		kind: "batch" as const,
		emittedAt: "2026-01-01T00:00:00.000Z",
		emittedAtEpochMs,
		timeoutMs: 600_000,
		deadlineAtEpochMs: emittedAtEpochMs + 600_000,
		attempt: 0,
		maxAttempts: 1,
		worker: "git-commit-generator",
		jobs: args.jobs,
	};
}

const mockAdapterFactories: LlmAdapterFactories = {
	buildSimplePrompt: ((prompt: unknown) =>
		prompt) as LlmAdapterFactories["buildSimplePrompt"],
	createOpenAIAdapter: (config) => {
		if (config.apiKey !== "key" && config.apiKey !== "mock-token") {
			throw new Error(`Unexpected OpenAI apiKey: ${config.apiKey}`);
		}
		return {
			call: async (rawArgs: unknown) => {
				const args = rawArgs as MockCallArgs;
				if (args.temperature !== 0) throw new Error("Unexpected temperature");
				lastUserPrompt = args.messages.user;
				return {
					content: JSON.stringify([
						{
							commit: {
								type: "feat",
								description: "mock openai commit",
								isBreaking: false,
							},
							files: ["src/index.ts"],
						},
					]),
				};
			},
		} as ReturnType<LlmAdapterFactories["createOpenAIAdapter"]>;
	},
	createAnthropicAdapter: (config) => {
		if (config.apiKey !== "key") throw new Error("Unexpected Anthropic apiKey");
		return {
			call: async (rawArgs: unknown) => {
				const args = rawArgs as MockCallArgs;
				if (args.temperature !== 0) throw new Error("Unexpected temperature");
				return {
					content: JSON.stringify([
						{
							commit: {
								type: "fix",
								description: "mock anthropic commit",
								isBreaking: false,
							},
							files: ["src/fix.ts"],
						},
					]),
				};
			},
		} as ReturnType<LlmAdapterFactories["createAnthropicAdapter"]>;
	},
	createGoogleAdapter: (config) => {
		if (config.apiKey !== "key") throw new Error("Unexpected Google apiKey");
		return {
			call: async (rawArgs: unknown) => {
				const args = rawArgs as MockCallArgs;
				if (args.temperature !== 0) throw new Error("Unexpected temperature");
				return {
					content: JSON.stringify([
						{
							commit: {
								type: "docs",
								description: "mock google commit",
								isBreaking: false,
							},
							files: ["README.md"],
						},
					]),
				};
			},
		} as ReturnType<LlmAdapterFactories["createGoogleAdapter"]>;
	},
	createOpenAICompatibleAdapter: (config) => {
		if (config.apiKey !== "key") throw new Error("Unexpected Custom apiKey");
		return {
			call: async (rawArgs: unknown) => {
				const args = rawArgs as MockCallArgs;
				if (args.temperature !== 0) throw new Error("Unexpected temperature");
				return {
					content: JSON.stringify([
						{
							commit: {
								type: "chore",
								description: "mock custom commit",
								isBreaking: false,
							},
							files: ["chore.ts"],
						},
					]),
				};
			},
		} as ReturnType<LlmAdapterFactories["createOpenAICompatibleAdapter"]>;
	},
};

const mockBridgeDependencies: BridgeDependencies = {
	resolveAuthToken: async (provider: string, agent?: string) => {
		lastAgentPassed = agent;
		if (provider === "fail") throw new Error("mock auth fail");
		return "mock-token";
	},
	invokeLlm: async (payload) => await invokeLlm(payload, mockAdapterFactories),
};

// Now import the functions to test
import {
	type BridgeDependencies,
	handleTurnlockDelegation,
	invokeLlm,
	type LlmAdapterFactories,
	parseSerializedValue,
} from "../../src/entrypoints/turnlock-to-llm-bridge.ts";

describe("turnlock-to-llm-bridge", () => {
	describe("parseSerializedValue", () => {
		test("removes surrounding double quotes", () => {
			assert.strictEqual(parseSerializedValue('"hello"'), "hello");
		});

		test("leaves unquoted string unchanged", () => {
			assert.strictEqual(parseSerializedValue("hello"), "hello");
		});

		test("handles empty string", () => {
			assert.strictEqual(parseSerializedValue(""), "");
		});
	});

	describe("invokeLlm", () => {
		test("calls openai adapter correctly", async () => {
			const res = await invokeLlm(
				{
					provider: "openai",
					model: "gpt-5.4-mini",
					token: "key",
					temperature: 0,
					systemPrompt: "sys",
					userPrompt: "user",
				},
				mockAdapterFactories,
			);
			assert.ok(res.includes("mock openai commit"));
		});

		test("calls anthropic adapter correctly", async () => {
			const res = await invokeLlm(
				{
					provider: "anthropic",
					model: "claude-test",
					token: "key",
					temperature: 0,
					systemPrompt: "sys",
					userPrompt: "user",
				},
				mockAdapterFactories,
			);
			assert.ok(res.includes("mock anthropic commit"));
		});

		test("calls google adapter correctly", async () => {
			const res = await invokeLlm(
				{
					provider: "google",
					model: "gemini-test",
					token: "key",
					temperature: 0,
					systemPrompt: "sys",
					userPrompt: "user",
				},
				mockAdapterFactories,
			);
			assert.ok(res.includes("mock google commit"));
		});

		test("calls custom adapter correctly", async () => {
			const res = await invokeLlm(
				{
					provider: "custom-provider",
					model: "custom-model",
					token: "key",
					temperature: 0,
					systemPrompt: "sys",
					userPrompt: "user",
				},
				mockAdapterFactories,
			);
			assert.ok(res.includes("mock custom commit"));
		});
	});

	describe("handleTurnlockDelegation", () => {
		let tempManifestPath: string;
		let tempResultPath: string;
		let tempDir: string;

		before(() => {
			tempDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "turnlock-wrapper-test-"),
			);
			tempManifestPath = path.join(tempDir, "manifest.json");
			tempResultPath = path.join(tempDir, "result.json");
		});

		after(() => {
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		test("processes jobs successfully and resumes turnlock", async () => {
			const mockJobPayload = {
				repository: "/path/to/repo",
				diff: "staged-diff",
				diffHash: "hash123",
				provider: "openai",
				model: "gpt-5.4-mini",
				temperature: 0,
				systemPrompt: "sys-prompt",
			};

			const manifest = createTurnlockV2BatchManifest({
				phase: "discovery-and-validation",
				resumeAt: "commit-and-push",
				label: "commit-jobs",
				jobs: [
					{
						id: "job-1",
						prompt: JSON.stringify(mockJobPayload),
						resultPath: tempResultPath,
					},
				],
			});

			fs.writeFileSync(tempManifestPath, JSON.stringify(manifest), "utf-8");
			lastExecCmd = null;

			await handleTurnlockDelegation(
				tempManifestPath,
				"resume-cmd --test",
				(cmd) => {
					lastExecCmd = cmd;
					return "";
				},
				mockBridgeDependencies,
			);

			// Verify result file exists and has success payload
			assert.strictEqual(fs.existsSync(tempResultPath), true);
			const resultData = JSON.parse(fs.readFileSync(tempResultPath, "utf-8"));
			assert.strictEqual(resultData.success, true);
			assert.strictEqual(resultData.id, "job-1");
			assert.strictEqual(resultData.commits[0].commit.type, "feat");
			assert.strictEqual(
				resultData.commits[0].commit.description,
				"mock openai commit",
			);

			// Verify execSync resume command was executed
			assert.strictEqual(lastExecCmd ?? "", "resume-cmd --test");
		});

		test("writes failure results on execution errors", async () => {
			const mockJobPayload = {
				repository: "/path/to/repo",
				diff: "staged-diff",
				diffHash: "hash123",
				provider: "fail", // will trigger mock resolver failure
				model: "gpt-5.4-mini",
				temperature: 0,
				systemPrompt: "sys-prompt",
			};

			const manifest = createTurnlockV2BatchManifest({
				phase: "discovery-and-validation",
				resumeAt: "commit-and-push",
				label: "commit-jobs",
				jobs: [
					{
						id: "job-2",
						prompt: JSON.stringify(mockJobPayload),
						resultPath: tempResultPath,
					},
				],
			});

			fs.writeFileSync(tempManifestPath, JSON.stringify(manifest), "utf-8");

			await handleTurnlockDelegation(
				tempManifestPath,
				"resume-cmd --test",
				(cmd) => {
					lastExecCmd = cmd;
					return "";
				},
				mockBridgeDependencies,
			);

			assert.strictEqual(fs.existsSync(tempResultPath), true);
			const resultData = JSON.parse(fs.readFileSync(tempResultPath, "utf-8"));
			assert.strictEqual(resultData.success, false);
			assert.strictEqual(resultData.id, "job-2");
			assert.ok(resultData.error.includes("LLM Fatal Error: mock auth fail"));
		});

		test("rejects a legacy manifest before processing jobs", async () => {
			const legacyManifest = {
				...createTurnlockV2BatchManifest({
					phase: "discovery-and-validation",
					resumeAt: "commit-and-push",
					label: "commit-jobs",
					jobs: [
						{
							id: "legacy-job",
							prompt: "{}",
							resultPath: tempResultPath,
						},
					],
				}),
				manifestVersion: 1,
				kind: "agent-batch",
			};
			fs.rmSync(tempResultPath, { force: true });
			fs.writeFileSync(
				tempManifestPath,
				JSON.stringify(legacyManifest),
				"utf-8",
			);
			let resumeWasCalled = false;

			await assert.rejects(
				handleTurnlockDelegation(
					tempManifestPath,
					"resume-cmd --test",
					() => {
						resumeWasCalled = true;
						return "";
					},
					mockBridgeDependencies,
				),
				(error: unknown) =>
					error instanceof Error &&
					error.message.includes(
						"Turnlock delegation manifest is not a valid v2 batch manifest",
					),
			);

			assert.strictEqual(resumeWasCalled, false);
			assert.strictEqual(fs.existsSync(tempResultPath), false);
		});

		test("injects feedback into prompt if present", async () => {
			const mockJobPayload = {
				repository: "/path/to/repo",
				diff: "staged-diff",
				diffHash: "hash123",
				provider: "openai",
				model: "gpt-5.4-mini",
				temperature: 0,
				systemPrompt: "sys-prompt",
				feedback: {
					previous_commit: "BAD COMMIT",
					errors: [
						{
							kind: "structural",
							message: "Error 1",
							resolution_hint: "Fix the duplicate file.",
							files: ["shared.ts"],
						},
						{ kind: "validation", message: "Error 2" },
					],
				},
			};

			const manifest = createTurnlockV2BatchManifest({
				phase: "commit-and-push",
				resumeAt: "commit-and-push",
				label: "commit-jobs-retry",
				jobs: [
					{
						id: "job-3",
						prompt: JSON.stringify(mockJobPayload),
						resultPath: tempResultPath,
					},
				],
			});

			fs.writeFileSync(tempManifestPath, JSON.stringify(manifest), "utf-8");
			lastUserPrompt = null;

			await handleTurnlockDelegation(
				tempManifestPath,
				"resume-cmd --test",
				() => {
					return "";
				},
				mockBridgeDependencies,
			);

			// New format: structured errors with [KIND] prefix
			assert.ok(
				(lastUserPrompt ?? "").includes("FEEDBACK FROM PREVIOUS ATTEMPT(S)"),
			);
			assert.ok((lastUserPrompt ?? "").includes("BAD COMMIT"));
			assert.ok((lastUserPrompt ?? "").includes("[STRUCTURAL] Error 1"));
			assert.ok((lastUserPrompt ?? "").includes("[VALIDATION] Error 2"));
			assert.ok(
				(lastUserPrompt ?? "").includes(
					"→ Resolution: Fix the duplicate file.",
				),
			);
			assert.ok((lastUserPrompt ?? "").includes("→ Affected files: shared.ts"));
		});

		test("passes agent to resolveAuthToken when present in payload", async () => {
			lastAgentPassed = undefined;
			const mockJobPayload = {
				repository: "/path/to/repo",
				diff: "staged-diff",
				diffHash: "hash123",
				provider: "openai",
				model: "gpt-5.4-mini",
				temperature: 0,
				systemPrompt: "sys-prompt",
				agent: "git-commits-push",
			};

			const manifest = createTurnlockV2BatchManifest({
				phase: "discovery-and-validation",
				resumeAt: "commit-and-push",
				label: "commit-jobs",
				jobs: [
					{
						id: "job-agent",
						prompt: JSON.stringify(mockJobPayload),
						resultPath: tempResultPath,
					},
				],
			});

			fs.writeFileSync(tempManifestPath, JSON.stringify(manifest), "utf-8");

			await handleTurnlockDelegation(
				tempManifestPath,
				"resume-cmd --test",
				() => "",
				mockBridgeDependencies,
			);

			assert.strictEqual(
				lastAgentPassed as string | undefined,
				"git-commits-push",
			);
		});

		test("does not pass agent when absent from payload", async () => {
			lastAgentPassed = undefined;
			const mockJobPayload = {
				repository: "/path/to/repo",
				diff: "staged-diff",
				diffHash: "hash123",
				provider: "openai",
				model: "gpt-5.4-mini",
				temperature: 0,
				systemPrompt: "sys-prompt",
			};

			const manifest = createTurnlockV2BatchManifest({
				phase: "discovery-and-validation",
				resumeAt: "commit-and-push",
				label: "commit-jobs",
				jobs: [
					{
						id: "job-no-agent",
						prompt: JSON.stringify(mockJobPayload),
						resultPath: tempResultPath,
					},
				],
			});

			fs.writeFileSync(tempManifestPath, JSON.stringify(manifest), "utf-8");

			await handleTurnlockDelegation(
				tempManifestPath,
				"resume-cmd --test",
				() => "",
				mockBridgeDependencies,
			);

			assert.strictEqual(lastAgentPassed, undefined);
		});
	});
});
