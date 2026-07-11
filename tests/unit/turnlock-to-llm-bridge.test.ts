// tests/unit/pi-orch-git-commits-push.test.ts
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Set up module mocks before importing the target wrapper
let lastExecCmd: string | null = null;
let lastUserPrompt: string | null = null;

interface MockAdapterConfig {
	readonly apiKey?: string;
}

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

mock.module("@fanilosendrison/llm-runtime", () => ({
	createOpenAIAdapter: (config: MockAdapterConfig) => {
		if (config.apiKey !== "key" && config.apiKey !== "mock-token") {
			throw new Error(`Unexpected OpenAI apiKey: ${config.apiKey}`);
		}
		return {
			call: async (args: MockCallArgs) => {
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
		};
	},
	createAnthropicAdapter: (config: MockAdapterConfig) => {
		if (config.apiKey !== "key") throw new Error("Unexpected Anthropic apiKey");
		return {
			call: async (args: MockCallArgs) => {
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
		};
	},
	createGoogleAdapter: (config: MockAdapterConfig) => {
		if (config.apiKey !== "key") throw new Error("Unexpected Google apiKey");
		return {
			call: async (args: MockCallArgs) => {
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
		};
	},
	createOpenAICompatibleAdapter: (config: MockAdapterConfig) => {
		if (config.apiKey !== "key") throw new Error("Unexpected Custom apiKey");
		return {
			call: async (args: MockCallArgs) => {
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
		};
	},
	buildSimplePrompt: <T>(p: T) => p,
}));

mock.module(
	path.resolve(__dirname, "../../src/modules/core/auth-resolver"),
	() => ({
		resolveAuthToken: async (provider: string) => {
			if (provider === "fail") {
				throw new Error("mock auth fail");
			}
			return "mock-token";
		},
	}),
);

// Now import the functions to test
import {
	handleTurnlockDelegation,
	invokeLlm,
	parseSerializedValue,
} from "../../src/entrypoints/turnlock-to-llm-bridge.ts";

describe("turnlock-to-llm-bridge", () => {
	describe("parseSerializedValue", () => {
		test("removes surrounding double quotes", () => {
			expect(parseSerializedValue('"hello"')).toBe("hello");
		});

		test("leaves unquoted string unchanged", () => {
			expect(parseSerializedValue("hello")).toBe("hello");
		});

		test("handles empty string", () => {
			expect(parseSerializedValue("")).toBe("");
		});
	});

	describe("invokeLlm", () => {
		test("calls openai adapter correctly", async () => {
			const res = await invokeLlm({
				provider: "openai",
				model: "gpt-5.4-mini",
				token: "key",
				temperature: 0,
				systemPrompt: "sys",
				userPrompt: "user",
			});
			expect(res).toContain("mock openai commit");
		});

		test("calls anthropic adapter correctly", async () => {
			const res = await invokeLlm({
				provider: "anthropic",
				model: "claude-test",
				token: "key",
				temperature: 0,
				systemPrompt: "sys",
				userPrompt: "user",
			});
			expect(res).toContain("mock anthropic commit");
		});

		test("calls google adapter correctly", async () => {
			const res = await invokeLlm({
				provider: "google",
				model: "gemini-test",
				token: "key",
				temperature: 0,
				systemPrompt: "sys",
				userPrompt: "user",
			});
			expect(res).toContain("mock google commit");
		});

		test("calls custom adapter correctly", async () => {
			const res = await invokeLlm({
				provider: "custom-provider",
				model: "custom-model",
				token: "key",
				temperature: 0,
				systemPrompt: "sys",
				userPrompt: "user",
			});
			expect(res).toContain("mock custom commit");
		});
	});

	describe("handleTurnlockDelegation", () => {
		let tempManifestPath: string;
		let tempResultPath: string;
		let tempDir: string;

		beforeAll(() => {
			tempDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "turnlock-wrapper-test-"),
			);
			tempManifestPath = path.join(tempDir, "manifest.json");
			tempResultPath = path.join(tempDir, "result.json");
		});

		afterAll(() => {
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
			);

			// Verify result file exists and has success payload
			expect(fs.existsSync(tempResultPath)).toBe(true);
			const resultData = JSON.parse(fs.readFileSync(tempResultPath, "utf-8"));
			expect(resultData.success).toBe(true);
			expect(resultData.id).toBe("job-1");
			expect(resultData.commits[0].commit.type).toBe("feat");
			expect(resultData.commits[0].commit.description).toBe(
				"mock openai commit",
			);

			// Verify execSync resume command was executed
			expect(lastExecCmd ?? "").toBe("resume-cmd --test");
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
			);

			expect(fs.existsSync(tempResultPath)).toBe(true);
			const resultData = JSON.parse(fs.readFileSync(tempResultPath, "utf-8"));
			expect(resultData.success).toBe(false);
			expect(resultData.id).toBe("job-2");
			expect(resultData.error).toContain("LLM Fatal Error: mock auth fail");
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

			await expect(
				handleTurnlockDelegation(tempManifestPath, "resume-cmd --test", () => {
					resumeWasCalled = true;
					return "";
				}),
			).rejects.toThrow(
				"Turnlock delegation manifest is not a valid v2 batch manifest",
			);

			expect(resumeWasCalled).toBe(false);
			expect(fs.existsSync(tempResultPath)).toBe(false);
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
			);

			// New format: structured errors with [KIND] prefix
			expect(lastUserPrompt ?? "").toContain(
				"FEEDBACK FROM PREVIOUS ATTEMPT(S)",
			);
			expect(lastUserPrompt ?? "").toContain("BAD COMMIT");
			expect(lastUserPrompt ?? "").toContain("[STRUCTURAL] Error 1");
			expect(lastUserPrompt ?? "").toContain("[VALIDATION] Error 2");
			expect(lastUserPrompt ?? "").toContain(
				"→ Resolution: Fix the duplicate file.",
			);
			expect(lastUserPrompt ?? "").toContain("→ Affected files: shared.ts");
		});
	});
});
