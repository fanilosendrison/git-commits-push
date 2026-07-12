/**
 * src/turnlock-to-llm-bridge.ts — LLM environment bridge.
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
import { z } from "zod";
import {
	setupCleanupHooks,
	startHeartbeat,
	stopHeartbeat,
} from "../utils/lock-manager.ts";

type OpenAICompatibleProvider =
	| "deepseek"
	| "mistral"
	| "groq"
	| "together"
	| "ollama";

import { resolveAuthToken } from "../modules/core/auth-resolver.ts";

export async function invokeLlm(payload: {
	provider: string;
	model: string;
	token: string;
	temperature: number;
	systemPrompt: string;
	userPrompt: string;
	stripJsonFence?: boolean;
	thinking?: boolean;
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
			provider: payload.provider as OpenAICompatibleProvider,
		});
	}

	const response = await adapter.call({
		messages: buildSimplePrompt({
			system: payload.systemPrompt,
			user: payload.userPrompt,
		}),
		temperature: payload.temperature,
		...(payload.thinking ? { thinking: true, reasoningEffort: "high" } : {}),
	});

	return response.content;
}

import { formatFeedbackBlock } from "../modules/core/feedback-formatter.ts";
import type {
	CommitJobPayload,
	CommitJobResult,
	CommitPlan,
} from "../types.ts";

const turnlockV2BatchManifestSchema = z.object({
	manifestVersion: z.literal(2),
	runId: z.string().min(1),
	orchestratorName: z.string().min(1),
	phase: z.string().min(1),
	resumeAt: z.string().min(1),
	label: z.string().min(1),
	kind: z.literal("batch"),
	emittedAt: z.string().min(1),
	emittedAtEpochMs: z.number().finite(),
	timeoutMs: z.number().positive(),
	deadlineAtEpochMs: z.number().finite(),
	attempt: z.number().int().nonnegative(),
	maxAttempts: z.number().int().positive(),
	worker: z.string().min(1).optional(),
	jobs: z
		.array(
			z.object({
				id: z.string().min(1),
				prompt: z.string(),
				resultPath: z.string().min(1),
			}),
		)
		.min(1),
});

type TurnlockBatchManifest = z.infer<typeof turnlockV2BatchManifestSchema>;

function parseTurnlockV2BatchManifest(content: string): TurnlockBatchManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error("Turnlock delegation manifest is not valid JSON");
	}

	const result = turnlockV2BatchManifestSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(
			"Turnlock delegation manifest is not a valid v2 batch manifest",
		);
	}

	return result.data;
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

/**
 * Parse TURNLOCK protocol blocks from a string and extract manifest/resume_cmd.
 */
function extractTurnlockBlocks(output: string): {
	manifestPath: string | null;
	resumeCmd: string | null;
} {
	let manifestPath: string | null = null;
	let resumeCmd: string | null = null;
	let inBlock = false;
	const blockLines: string[] = [];

	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "@@TURNLOCK@@") {
			inBlock = true;
			blockLines.length = 0;
			continue;
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
			continue;
		}
		if (inBlock) {
			blockLines.push(line);
		}
	}

	return { manifestPath, resumeCmd };
}

export async function handleTurnlockDelegation(
	manifestPath: string,
	resumeCmd: string,
	execFn: (cmd: string) => string = (cmd) =>
		execSync(cmd, { encoding: "utf-8" }),
): Promise<void> {
	if (!fs.existsSync(manifestPath)) {
		throw new Error(`Manifest file not found at ${manifestPath}`);
	}

	const manifestContent = fs.readFileSync(manifestPath, "utf-8");
	const manifest = parseTurnlockV2BatchManifest(manifestContent);

	startHeartbeat();
	setupCleanupHooks(manifest.runId);

	console.log(
		`\n[Turnlock→LLM] Received batch delegation for '${manifest.label}' with ${manifest.jobs.length} jobs.`,
	);

	// Run LLM inference in parallel
	await Promise.all(
		manifest.jobs.map(async (job) => {
			try {
				const payload: CommitJobPayload = JSON.parse(job.prompt);
				console.log(
					`[Turnlock→LLM] [${job.id}] Resolving token for provider: ${payload.provider}${payload.agent ? ` (agent: ${payload.agent})` : ""}...`,
				);
				const token = await resolveAuthToken(payload.provider, payload.agent);

				console.log(
					`[Turnlock→LLM] [${job.id}] Invoking LLM (${payload.provider}/${payload.model})...`,
				);
				let finalUserPrompt: string;
				if (payload.feedback?.pending_files) {
					// Partial commit retry: the reconstructed diff is only for pending files,
					// rendered inside <remaining-diff>. No separate diff prefix needed.
					finalUserPrompt = formatFeedbackBlock(payload.feedback, payload.diff);
				} else {
					// First attempt or validation retry: show the full diff, then feedback
					// (without duplicating the diff — not shown in <remaining-diff>).
					finalUserPrompt = payload.diff;
					if (payload.feedback) {
						finalUserPrompt += formatFeedbackBlock(payload.feedback);
					}
				}

				// Retry loop: LLM sometimes returns malformed JSON (transient)
				let llmResponse = "";
				let commits: CommitPlan[] = [];
				for (let attempt = 0; attempt < 2; attempt++) {
					llmResponse = await invokeLlm({
						provider: payload.provider,
						model: payload.model,
						token: token,
						temperature: payload.temperature,
						systemPrompt: payload.systemPrompt,
						userPrompt: finalUserPrompt,
						stripJsonFence: true, // Mandatory per specs
					});

					console.log(
						`[Turnlock→LLM] [${job.id}] LLM response received (attempt ${attempt + 1}). Parsing JSON...`,
					);
					try {
						commits = JSON.parse(llmResponse);
						if (Array.isArray(commits)) break;
					} catch {
						console.warn(
							`[Turnlock→LLM] [${job.id}] Invalid JSON on attempt ${attempt + 1}, retrying...`,
						);
					}
				}
				if (!Array.isArray(commits) || commits.length === 0) {
					throw new Error(
						"LLM returned an invalid response: expected a JSON array of commit plans.",
					);
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
					`[Turnlock→LLM] [${job.id}] Success result written to ${job.resultPath}`,
				);
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);
				console.error(`[Turnlock→LLM] [${job.id}] Error: ${errMsg}`);
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
		`\n[Turnlock→LLM] All jobs processed. Resuming orchestrator with command: ${resumeCmd}\n`,
	);

	stopHeartbeat();

	// Print the resumed orchestrator's output even if it fails (report is in stdout)
	let output = "";
	try {
		output = execFn(resumeCmd);
	} catch (e: unknown) {
		// execSync captures stdout before throwing — preserve it for display
		output =
			e && typeof e === "object" && "stdout" in e
				? String((e as { stdout: unknown }).stdout)
				: output;
		throw e;
	} finally {
		process.stdout.write(output);
	}

	// Check if the orchestrator emitted another delegation (retry)
	const { manifestPath: nextManifest, resumeCmd: nextResume } =
		extractTurnlockBlocks(output);
	if (nextManifest && nextResume) {
		console.log(
			`\n[Turnlock→LLM] Retry delegation detected. Processing next cycle...\n`,
		);
		await handleTurnlockDelegation(nextManifest, nextResume, execFn);
	}
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
				console.error(`[Turnlock→LLM] Delegation execution failed: ${errMsg}`);
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
