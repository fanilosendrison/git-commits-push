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

mock.module(path.resolve(__dirname, "../../src/modules/core/auth-resolver"), () => ({
	resolveAuthToken: async (provider: string) => {
		if (provider === "fail") {
			throw new Error("mock auth fail");
		}
		return "mock-token";
	},
}));

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

			const manifest = {
				manifestVersion: 1,
				runId: "run-123",
				orchestratorName: "git-commits-push-tl",
				phase: "discovery-and-validation",
				resumeAt: "commit-and-push",
				label: "commit-jobs",
				kind: "agent-batch",
				jobs: [
					{
						id: "job-1",
						prompt: JSON.stringify(mockJobPayload),
						resultPath: tempResultPath,
					},
				],
			};

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

			const manifest = {
				manifestVersion: 1,
				runId: "run-123",
				orchestratorName: "git-commits-push-tl",
				phase: "discovery-and-validation",
				resumeAt: "commit-and-push",
				label: "commit-jobs",
				kind: "agent-batch",
				jobs: [
					{
						id: "job-2",
						prompt: JSON.stringify(mockJobPayload),
						resultPath: tempResultPath,
					},
				],
			};

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

			const manifest = {
				manifestVersion: 1,
				runId: "run-123",
				orchestratorName: "git-commits-push-tl",
				phase: "commit-and-push",
				resumeAt: "commit-and-push",
				label: "commit-jobs-retry",
				kind: "agent-batch",
				jobs: [
					{
						id: "job-3",
						prompt: JSON.stringify(mockJobPayload),
						resultPath: tempResultPath,
					},
				],
			};

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
