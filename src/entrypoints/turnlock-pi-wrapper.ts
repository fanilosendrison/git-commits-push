/**
 * src/turnlock-pi-wrapper.ts — Pi environment wrapper.
 * Intercepts @@TURNLOCK@@ DELEGATE protocol blocks from stdout of turnlock-orchestrator.ts,
 * runs the parallel LLM inferences using @fanilosendrison/llm-runtime,
 * and resumes turnlock.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import {
	buildSimplePrompt,
	createAnthropicAdapter,
	createGoogleAdapter,
	createOpenAIAdapter,
	createOpenAICompatibleAdapter,
	type ProviderAdapter,
} from "@fanilosendrison/llm-runtime";
import { resolveAuthToken } from "../modules/auth-resolver.ts";

export async function invokeLlm(payload: {
	provider: string;
	model: string;
	token: string;
	temperature: number;
	systemPrompt: string;
	userPrompt: string;
	stripJsonFence?: boolean;
}): Promise<string> {
	const commonConfig = {
		model: payload.model,
		apiKey: payload.token,
		sanitization: {
			stripThinkingTags: true,
			stripJsonFence: payload.stripJsonFence ?? true,
		},
	};

	let adapter: ProviderAdapter;
	if (payload.provider === "anthropic") {
		adapter = createAnthropicAdapter(commonConfig);
	} else if (payload.provider === "openai") {
		adapter = createOpenAIAdapter(commonConfig);
	} else if (payload.provider === "google") {
		adapter = createGoogleAdapter(commonConfig);
	} else {
		adapter = createOpenAICompatibleAdapter({
			...commonConfig,
			provider: payload.provider as any,
		});
	}

	const response = await adapter.call({
		messages: buildSimplePrompt({
			system: payload.systemPrompt,
			user: payload.userPrompt,
		}),
		temperature: payload.temperature,
	});

	return response.content;
}

interface CommitJobPayload {
	repository: string;
	diff: string;
	diffHash: string;
	provider: string;
	model: string;
	temperature: number;
	systemPrompt: string;
	feedback?: {
		previous_commit: string;
		validation_errors: string[];
	};
}

interface CommitMessage {
	type: string;
	scope?: string;
	description: string;
	body?: string;
	isBreaking: boolean;
}

interface CommitPlan {
	commit: CommitMessage;
	files: string[];
}

interface CommitJobResultSuccess {
	success: true;
	id: string;
	commits: CommitPlan[];
}

interface CommitJobResultError {
	success: false;
	id: string;
	error: string;
}

type CommitJobResult = CommitJobResultSuccess | CommitJobResultError;

interface TurnlockBatchManifest {
	manifestVersion: number;
	runId: string;
	orchestratorName: string;
	phase: string;
	resumeAt: string;
	label: string;
	kind: "agent-batch";
	jobs: { id: string; prompt: string; resultPath: string }[];
}

export function parseSerializedValue(val: string): string {
	if (val.startsWith('"') && val.endsWith('"')) {
		try {
			return JSON.parse(val);
		} catch {
			return val.slice(1, -1);
		}
	}
	return val;
}

export async function handleTurnlockDelegation(
	manifestPath: string,
	resumeCmd: string,
	execFn: (cmd: string) => void = (cmd) => execSync(cmd, { stdio: "inherit" }),
): Promise<void> {
	if (!fs.existsSync(manifestPath)) {
		throw new Error(`Manifest file not found at ${manifestPath}`);
	}

	const manifestContent = fs.readFileSync(manifestPath, "utf-8");
	const manifest: TurnlockBatchManifest = JSON.parse(manifestContent);

	console.log(
		`\n[Pi Wrapper] Received batch delegation for '${manifest.label}' with ${manifest.jobs.length} jobs.`,
	);

	// Run LLM inference in parallel
	await Promise.all(
		manifest.jobs.map(async (job) => {
			try {
				const payload: CommitJobPayload = JSON.parse(job.prompt);
				console.log(
					`[Pi Wrapper] [${job.id}] Resolving token for provider: ${payload.provider}...`,
				);
				const token = await resolveAuthToken(payload.provider);

				console.log(
					`[Pi Wrapper] [${job.id}] Invoking LLM (${payload.provider}/${payload.model})...`,
				);
				let finalUserPrompt = payload.diff;
				if (payload.feedback) {
					finalUserPrompt += `\n\n--- FEEDBACK FROM PREVIOUS FAILED ATTEMPT ---\n`;
					finalUserPrompt += `Your previous commit plan was rejected due to formatting errors.\n\n`;
					finalUserPrompt += `Previous attempt (all commits):\n${payload.feedback.previous_commit}\n\n`;
					finalUserPrompt += `Validation Errors:\n${payload.feedback.validation_errors.map((e) => `- ${e}`).join("\n")}\n\n`;
					finalUserPrompt += `Please generate a NEW JSON array fixing these exact errors.\n`;
				}

				const llmResponse = await invokeLlm({
					provider: payload.provider,
					model: payload.model,
					token: token,
					temperature: payload.temperature,
					systemPrompt: payload.systemPrompt,
					userPrompt: finalUserPrompt,
					stripJsonFence: true, // Mandatory per specs
				});

				console.log(
					`[Pi Wrapper] [${job.id}] LLM response received. Parsing JSON...`,
				);
				const commits: CommitPlan[] = JSON.parse(llmResponse);
				if (!Array.isArray(commits) || commits.length === 0) {
					throw new Error("LLM returned an invalid response: expected a non-empty JSON array of commit plans.");
				}

				// Ensure directory for result exists
				const dir = path.dirname(job.resultPath);
				if (!fs.existsSync(dir)) {
					fs.mkdirSync(dir, { recursive: true });
				}

				const successResult: CommitJobResult = {
					success: true,
					id: job.id,
					commits,
				};
				fs.writeFileSync(
					job.resultPath,
					JSON.stringify(successResult, null, 2),
					"utf-8",
				);
				console.log(
					`[Pi Wrapper] [${job.id}] Success result written to ${job.resultPath}`,
				);
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);
				console.error(`[Pi Wrapper] [${job.id}] Error: ${errMsg}`);
				const errorResult: CommitJobResult = {
					success: false,
					id: job.id,
					error: `LLM Fatal Error: ${errMsg}`,
				};
				const dir = path.dirname(job.resultPath);
				if (!fs.existsSync(dir)) {
					fs.mkdirSync(dir, { recursive: true });
				}
				fs.writeFileSync(
					job.resultPath,
					JSON.stringify(errorResult, null, 2),
					"utf-8",
				);
			}
		}),
	);

	console.log(
		`\n[Pi Wrapper] All jobs processed. Resuming orchestrator with command: ${resumeCmd}\n`,
	);
	execFn(resumeCmd);
}

export async function main() {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: false,
	});

	let inBlock = false;
	const blockLines: string[] = [];
	let manifestPath: string | null = null;
	let resumeCmd: string | null = null;

	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (trimmed === "@@TURNLOCK@@") {
			inBlock = true;
			return;
		}

		if (trimmed === "@@END@@") {
			inBlock = false;
			for (const bl of blockLines) {
				const matchManifest = bl.match(/^manifest: (.*)$/);
				if (matchManifest && matchManifest[1] !== undefined) {
					manifestPath = parseSerializedValue(matchManifest[1]);
				}
				const matchResume = bl.match(/^resume_cmd: (.*)$/);
				if (matchResume && matchResume[1] !== undefined) {
					resumeCmd = parseSerializedValue(matchResume[1]);
				}
			}
			blockLines.length = 0;
			return;
		}

		if (inBlock) {
			blockLines.push(line);
		} else {
			console.log(line);
		}
	});

	rl.on("close", async () => {
		if (manifestPath && resumeCmd) {
			try {
				await handleTurnlockDelegation(manifestPath, resumeCmd);
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);
				console.error(`[Pi Wrapper] Delegation execution failed: ${errMsg}`);
				process.exit(1);
			}
		} else {
			process.exit(0);
		}
	});
}

if (import.meta.main) {
	main();
}
