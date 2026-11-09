/**
 * src/turnlock-to-llm-bridge.ts — LLM environment bridge.
 * Intercepts @@TURNLOCK@@ DELEGATE protocol blocks from stdout of turnlock-orchestrator.ts,
 * runs the parallel LLM inferences using @fanilosendrison/llm-runtime,
 * and resumes turnlock.
 */

import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveAuthToken } from "../modules/core/auth-resolver.ts";
import { sanitizeSensitiveDiagnostic } from "../modules/core/sensitive-diagnostic-sanitizer.ts";
import {
	invokeLlm,
	type LlmAdapterFactories,
} from "../modules/llm/llm-invoker.ts";
import { createLlmJobFailure } from "../modules/llm/provider-failure.ts";
import { parseTurnlockBatchManifest } from "../modules/turnlock/batch-manifest.ts";
import { writeCommitJobResult } from "../modules/turnlock/job-result-store.ts";
import { handlePreparedMergeRequest } from "../modules/turnlock/prepared-merge-request.ts";
import {
	extractTurnlockBlocks,
	parseSerializedValue,
} from "../modules/turnlock/protocol-blocks.ts";
import { acknowledgePublicationCheckpoint } from "../modules/turnlock/publication-checkpoint.ts";

export { parseSerializedValue } from "../modules/turnlock/protocol-blocks.ts";

import { isDirectExecution } from "../utils/direct-execution.ts";
import {
	buildResumeCommand,
	buildResumeLaunch,
	isCompiledJavaScriptModule,
} from "../utils/runtime-launch.ts";

export { invokeLlm, type LlmAdapterFactories };

function logBridgeMessage(message: string): void {
	if (isCompiledJavaScriptModule(import.meta.url)) {
		process.stderr.write(`${message}\n`);
		return;
	}
	console.log(message);
}

import { parseCommitJobResponse } from "../modules/core/commit-job-response.ts";
import {
	COMMIT_MESSAGE_REPAIR_SYSTEM_PROMPT,
	formatCommitMessageRepairPrompt,
} from "../modules/core/commit-message-repair.ts";
import { formatFeedbackBlock } from "../modules/core/feedback-formatter.ts";
import type {
	BridgeJobPayload,
	CommitJobResult,
	CommitPlan,
} from "../types.ts";

class ResumeExecutionError extends Error {
	readonly stdout: string;

	constructor(message: string, stdout: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ResumeExecutionError";
		this.stdout = stdout;
	}
}

export async function executeResumeCommand(
	resumeCommand: string,
	runId: string,
	bridgeModuleUrl: string = import.meta.url,
): Promise<string> {
	if (!isCompiledJavaScriptModule(bridgeModuleUrl)) {
		return execSync(resumeCommand, { encoding: "utf-8" });
	}

	const bridgePath = fileURLToPath(bridgeModuleUrl);
	const orchestratorPath = path.join(
		path.dirname(bridgePath),
		"turnlock-orchestrator.js",
	);
	const orchestratorUrl = pathToFileURL(orchestratorPath).href;
	const expectedCommand = buildResumeCommand(runId, orchestratorUrl);
	if (resumeCommand !== expectedCommand) {
		throw new Error(
			"Resume command is incompatible with the compiled Node runtime. " +
				"Close the historical run explicitly and start a fresh run.",
		);
	}

	const launch = buildResumeLaunch(runId, orchestratorUrl);
	const result = spawnSync(launch.command, [...launch.args], {
		cwd: launch.cwd,
		encoding: "utf-8",
		env: process.env,
		maxBuffer: 50 * 1024 * 1024,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	if (stderr.length > 0) process.stderr.write(stderr);
	if (result.error) {
		throw new ResumeExecutionError(
			`Compiled resume failed to start: ${result.error.message}`,
			stdout,
			{ cause: result.error },
		);
	}
	if (result.status !== 0) {
		const outcome =
			result.status === null
				? `signal ${result.signal ?? "unknown"}`
				: `exit code ${result.status}`;
		throw new ResumeExecutionError(
			`Compiled resume failed with ${outcome}`,
			stdout,
		);
	}
	return stdout;
}

export interface BridgeDependencies {
	readonly invokeLlm: typeof invokeLlm;
	readonly resolveAuthToken: typeof resolveAuthToken;
}

const defaultBridgeDependencies: BridgeDependencies = {
	invokeLlm,
	resolveAuthToken,
};

export async function handleTurnlockDelegation(
	manifestPath: string,
	resumeCmd: string,
	execFn?: (cmd: string) => string | Promise<string>,
	dependencies: BridgeDependencies = defaultBridgeDependencies,
): Promise<void> {
	if (!fs.existsSync(manifestPath)) {
		throw new Error(`Manifest file not found at ${manifestPath}`);
	}

	const manifestContent = fs.readFileSync(manifestPath, "utf-8");
	const envelope: unknown = JSON.parse(manifestContent);
	if (
		typeof envelope === "object" &&
		envelope !== null &&
		"kind" in envelope &&
		envelope.kind === "external-request"
	) {
		const manifest = handlePreparedMergeRequest(manifestPath, manifestContent);
		await resumeAndProcess(manifest.runId, resumeCmd, execFn, dependencies);
		return;
	}
	const manifest = parseTurnlockBatchManifest(manifestContent);

	logBridgeMessage(
		`\n[Turnlock→LLM] Received batch delegation for '${manifest.label}' with ${manifest.jobs.length} jobs.`,
	);

	// Run LLM inference in parallel
	await Promise.all(
		manifest.jobs.map(async (job) => {
			let rejectedPlans: CommitPlan[] | undefined;
			try {
				const payload: BridgeJobPayload = JSON.parse(job.prompt);
				if (payload.mode === "repair-commit-messages")
					rejectedPlans = payload.rejectedPlans;
				if (acknowledgePublicationCheckpoint(payload, job)) {
					logBridgeMessage(
						`[Turnlock→LLM] [${job.id}] Durable ${payload.mode} acknowledged.`,
					);
					return;
				}
				logBridgeMessage(
					`[Turnlock→LLM] [${job.id}] Resolving token for provider: ${payload.provider}${payload.agent ? ` (agent: ${payload.agent})` : ""}...`,
				);
				const token = await dependencies.resolveAuthToken(
					payload.provider,
					payload.agent,
				);

				logBridgeMessage(
					`[Turnlock→LLM] [${job.id}] Invoking LLM (${payload.provider}/${payload.model})...`,
				);
				const isCommitMessageRepair = payload.mode === "repair-commit-messages";
				let finalUserPrompt: string;
				if (isCommitMessageRepair) {
					finalUserPrompt = formatCommitMessageRepairPrompt(payload);
				} else if (payload.feedback?.pending_files) {
					// Partial commit retry: the reconstructed diff is only for pending files,
					// rendered inside <remaining-diff>. No separate diff prefix needed.
					finalUserPrompt = formatFeedbackBlock(payload.feedback, payload.diff);
				} else {
					finalUserPrompt = payload.diff;
					if (payload.feedback) {
						finalUserPrompt += formatFeedbackBlock(payload.feedback);
					}
				}

				// Retry malformed or mode-invalid LLM responses locally at most once.
				let commits: CommitPlan[] | undefined;
				let responseError: unknown;
				for (let attempt = 0; attempt < 2; attempt++) {
					const llmResponse = await dependencies.invokeLlm({
						provider: payload.provider,
						model: payload.model,
						token: token,
						temperature: payload.temperature,
						systemPrompt: isCommitMessageRepair
							? COMMIT_MESSAGE_REPAIR_SYSTEM_PROMPT
							: payload.systemPrompt,
						userPrompt: finalUserPrompt,
						stripJsonFence: true, // Mandatory per specs
						...(payload.thinking !== undefined
							? { thinking: payload.thinking }
							: {}),
					});

					logBridgeMessage(
						`[Turnlock→LLM] [${job.id}] LLM response received (attempt ${attempt + 1}). Parsing JSON...`,
					);
					try {
						commits = parseCommitJobResponse(payload, llmResponse);
						break;
					} catch (error) {
						responseError = error;
						if (attempt < 1) {
							console.warn(
								`[Turnlock→LLM] [${job.id}] Invalid LLM response on attempt ${attempt + 1}, retrying...`,
							);
						}
					}
				}
				if (!commits) {
					throw responseError instanceof Error
						? responseError
						: new Error("LLM returned an invalid response.");
				}

				const successResult: CommitJobResult = {
					success: true,
					id: job.id,
					commits,
				};
				writeCommitJobResult(job.resultPath, successResult);
				logBridgeMessage(
					`[Turnlock→LLM] [${job.id}] Success result written to ${job.resultPath}`,
				);
			} catch (err: unknown) {
				const errorResult = {
					...createLlmJobFailure(job.id, err),
					...(rejectedPlans ? { rejectedPlans } : {}),
				};
				console.error(`[Turnlock→LLM] [${job.id}] Error: ${errorResult.error}`);
				writeCommitJobResult(job.resultPath, errorResult);
			}
		}),
	);

	logBridgeMessage(
		`\n[Turnlock→LLM] All jobs processed. Resuming orchestrator with command: ${resumeCmd}\n`,
	);

	await resumeAndProcess(manifest.runId, resumeCmd, execFn, dependencies);
}

async function resumeAndProcess(
	runId: string,
	resumeCmd: string,
	execFn: ((cmd: string) => string | Promise<string>) | undefined,
	dependencies: BridgeDependencies,
): Promise<void> {
	// Print the resumed orchestrator's output even if it fails (report is in stdout)
	let output = "";
	try {
		output = execFn
			? await execFn(resumeCmd)
			: await executeResumeCommand(resumeCmd, runId);
	} catch (e: unknown) {
		// Resume execution captures stdout before throwing — preserve it for display.
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
		logBridgeMessage(
			`\n[Turnlock→LLM] Retry delegation detected. Processing next cycle...\n`,
		);
		await handleTurnlockDelegation(
			nextManifest,
			nextResume,
			execFn,
			dependencies,
		);
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
			logBridgeMessage(line);
		}
	});

	rl.on("close", async () => {
		if (manifestPath && resumeCmd) {
			try {
				await handleTurnlockDelegation(manifestPath, resumeCmd);
			} catch (err: unknown) {
				const errMsg = sanitizeSensitiveDiagnostic(
					err instanceof Error ? err.message : String(err),
				);
				console.error(`[Turnlock→LLM] Delegation execution failed: ${errMsg}`);
				process.exit(1);
			}
		} else {
			process.exit(0);
		}
	});
}

if (isDirectExecution(import.meta.url)) {
	main();
}
