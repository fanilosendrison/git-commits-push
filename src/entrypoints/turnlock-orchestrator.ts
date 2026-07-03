/**
 * src/turnlock-orchestrator.ts — Main entrypoint for the git-commits-push-TL skill.
 * Orchestrates Phase 1-5 via Turnlock state machine.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OrchestratorConfig } from "turnlock";
import { definePhase, runOrchestrator } from "turnlock";
import { z } from "zod";
import { readSettings } from "../config/settings.ts";
import { runDiscovery } from "../modules/discovery.ts";
import {
	executeMultiCommitAndPush,
	formatConventionalCommit,
} from "../modules/git-publisher.ts";
import { processRepoValidationAndDiff } from "../modules/pre-commit-validators.ts";
import { printReport } from "../modules/reporter.ts";
import type { CommitJobPayload, GlobalState } from "../types.ts";

const commitMessageSchema = z.object({
	type: z.string(),
	scope: z.string().optional(),
	description: z.string(),
	body: z.string().optional(),
	isBreaking: z.boolean(),
});

const commitPlanSchema = z.object({
	commit: commitMessageSchema,
	files: z.array(z.string()),
});

const commitJobResultSchema = z.union([
	z.object({
		success: z.literal(true),
		id: z.string(),
		commits: z.array(commitPlanSchema),
	}),
	z.object({
		success: z.literal(false),
		id: z.string(),
		error: z.string(),
	}),
]);

const stateSchema = z.object({
	repos: z.record(
		z.string(),
		z.object({
			repository: z.string(),
			status: z.enum(["PENDING", "RUNNING", "SUCCESS", "FAILED"]),
			diffHash: z.string().optional(),
			commits: z.array(commitPlanSchema).optional(),
			error: z.string().optional(),
			attempts: z.number().optional(),
		}),
	),
});

const config: OrchestratorConfig<GlobalState> = {
	name: "git-commits-push-tl",
	initial: "discovery-and-validation",
	initialState: { repos: {} },
	resumeCommand: (runId) =>
		`bun run src/entrypoints/turnlock-orchestrator.ts --run-id ${runId} --resume`,
	runDirRoot: path.join(os.homedir(), ".turnlock", "runs"),
	stateSchema,
	phases: {
		"discovery-and-validation": definePhase(async (state, io) => {
			const settings = readSettings(path.resolve(__dirname, "../config"));

			// Try to read system prompt if present, else empty string
			let systemPrompt = "";
			try {
				const promptPath = path.resolve(
					__dirname,
					settings.systemPromptPath || "../../system-prompt.md",
				);
				if (fs.existsSync(promptPath)) {
					systemPrompt = fs.readFileSync(promptPath, "utf-8");
				}
			} catch (err) {
				process.stderr.write(
					`[orchestrator] Could not read system prompt: ${err}\n`,
				);
			}

			// Phase 1: Discovery
			const repos = await runDiscovery(settings);
			if (repos.length === 0) {
				process.stderr.write(
					"[orchestrator] No repositories with changes found. Exiting.\n",
				);
				printReport({});
				return io.done({});
			}

			// Phase 2: Validation
			const validRepos: Array<{
				id: string;
				path: string;
				diff: string;
				diffHash: string;
			}> = [];
			const nextRepos = { ...state.repos };

			for (const repo of repos) {
				try {
					const { diff, diffHash } = await processRepoValidationAndDiff(
						repo,
						settings,
					);
					validRepos.push({ id: repo.id, path: repo.path, diff, diffHash });
					nextRepos[repo.id] = {
						repository: repo.path,
						status: "PENDING",
						diffHash,
					};
				} catch (err) {
					// Validation failed (tests, secret scan, etc). Mark as failed immediately.
					const msg = err instanceof Error ? err.message : String(err);
					nextRepos[repo.id] = {
						repository: repo.path,
						status: "FAILED",
						error: msg,
					};
				}
			}

			if (validRepos.length === 0) {
				process.stderr.write(
					"[orchestrator] No repositories passed validation. Exiting.\n",
				);
				printReport(nextRepos);
				const hasFailedRepo = Object.values(nextRepos).some(
					(r) => r.status === "FAILED",
				);
				if (hasFailedRepo) {
					return io.fail(
						new Error(
							"No repositories passed validation. Check report for details.",
						),
					);
				}
				return io.done({});
			}

			// Phase 3: Delegate to LLM
			const jobs = validRepos.map((r) => {
				const payload: CommitJobPayload = {
					repository: r.path,
					diff: r.diff,
					diffHash: r.diffHash,
					provider: settings.provider,
					model: settings.model,
					temperature: settings.temperature,
					systemPrompt,
				};
				return {
					id: r.id,
					prompt: JSON.stringify(payload),
				};
			});

			for (const r of validRepos) {
				nextRepos[r.id].status = "RUNNING";
			}

			return io.delegateAgentBatch(
				{
					kind: "agent-batch",
					agentType: "git-commit-generator",
					label: "commit-jobs",
					jobs,
					timeout: 600_000,
					retry: { maxAttempts: 1, backoffBaseMs: 1000, maxBackoffMs: 30000 },
				},
				"commit-and-push",
				{ repos: nextRepos },
			);
		}),

		"commit-and-push": definePhase(async (state, io) => {
			const settings = readSettings(path.resolve(__dirname, "../config"));

			// Dynamically load the validator
			let validateCommitMessage: any = null;
			const validatorPath = path.resolve(
				__dirname,
				"../../../../../agent-enforcers/commit-msg-validator/src/core/validator.ts",
			);
			if (fs.existsSync(validatorPath)) {
				const module = await import(validatorPath);
				validateCommitMessage = module.validateCommitMessage;
			}

			// Try to read system prompt if present, else empty string
			let systemPrompt = "";
			try {
				const promptPath = path.resolve(
					__dirname,
					settings.systemPromptPath || "../../system-prompt.md",
				);
				if (fs.existsSync(promptPath)) {
					systemPrompt = fs.readFileSync(promptPath, "utf-8");
				}
			} catch (_err) {
				// ignore
			}

			// Phase 4: Retrieve results
			const results = io.consumePendingBatchResults(commitJobResultSchema);
			const nextRepos = { ...state.repos };
			const retryJobs: any[] = [];

			for (const result of results) {
				const repoState = nextRepos[result.id];
				if (!repoState) continue; // Should never happen unless state was corrupted

				if (!result.success) {
					nextRepos[result.id] = {
						...repoState,
						status: "FAILED",
						error: result.error,
					};
					continue;
				}

				if (validateCommitMessage) {
					// Validate every commit in the plan
					const allErrors: string[] = [];
					const allFormatted: string[] = [];
					for (const plan of result.commits) {
						const msgStr = formatConventionalCommit(plan.commit);
						allFormatted.push(msgStr);
						const valRes = validateCommitMessage(msgStr);
						if (!valRes.valid) {
							for (const e of valRes.errors) {
								allErrors.push(`[${msgStr}] ${e}`);
							}
						}
					}
					if (allErrors.length > 0) {
						const attempts = repoState.attempts || 0;
						if (attempts < 1) {
							nextRepos[result.id].attempts = attempts + 1;
							const diff = execSync("git diff --cached", {
								cwd: repoState.repository,
								encoding: "utf-8",
							}).toString();
							const payload: CommitJobPayload = {
								repository: repoState.repository,
								diff,
								diffHash: repoState.diffHash!,
								provider: settings.provider,
								model: settings.model,
								temperature: settings.temperature,
								systemPrompt,
								feedback: {
									previous_commit: allFormatted.join("\n---\n"),
									validation_errors: allErrors,
								},
							};
							retryJobs.push({
								id: result.id,
								prompt: JSON.stringify(payload),
							});
							continue;
						} else {
							nextRepos[result.id] = {
								...repoState,
								status: "FAILED",
								error: `Validation failed after max retries: ${allErrors.join(", ")}`,
							};
							continue;
						}
					}
				}

				try {
					await executeMultiCommitAndPush(
						repoState.repository,
						result.commits,
						repoState.diffHash!,
						settings,
					);
					nextRepos[result.id] = {
						...repoState,
						status: "SUCCESS",
						commits: result.commits,
					};
				} catch (err) {
					nextRepos[result.id] = {
						...repoState,
						status: "FAILED",
						error: err instanceof Error ? err.message : String(err),
					};
				}
			}

			if (retryJobs.length > 0) {
				return io.delegateAgentBatch(
					{
						kind: "agent-batch",
						agentType: "git-commit-generator",
						label: "commit-jobs-retry",
						jobs: retryJobs,
						timeout: 600_000,
						retry: { maxAttempts: 1, backoffBaseMs: 1000, maxBackoffMs: 30000 },
					},
					"commit-and-push",
					{ repos: nextRepos },
				);
			}

			// Phase 5: Reporting
			printReport(nextRepos);

			const hasFailedRepo = Object.values(nextRepos).some(
				(r) => r.status === "FAILED",
			);
			if (hasFailedRepo) {
				return io.fail(
					new Error(
						"One or more repositories failed to publish commits. Check report.",
					),
				);
			}

			return io.done({});
		}),
	},
};

// Start orchestrator only if called directly
if (import.meta.main) {
	runOrchestrator(config).catch((err) => {
		process.stderr.write(
			`[Fatal Error] ${err instanceof Error ? err.message : String(err)}\n`,
		);
		process.exit(1);
	});
}
