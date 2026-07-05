/**
 * src/turnlock-orchestrator.ts — Main entrypoint for the git-commits-push-TL skill.
 * Orchestrates Phase 1-5 via Turnlock state machine.
 *
 * Phase 4 refactor (plan unified-retry-on-all-catches):
 *   - Updated stateSchema with new fields (R30, R37, R48, R58, R62)
 *   - LLM-side failure classification via classifyLLMFailure (R7, R27)
 *   - Validation retry via queueRetry with FeedbackError[]
 *   - Execution error classification via classifyError (R43)
 *   - Module-scope retryJobs with reset at phase entry (Decision 9, R26)
 *   - committedShas accumulation from error context (R59)
 *   - R74: orchestrator re-attempts git reset HEAD before queueRetry
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OrchestratorConfig } from "turnlock";
import { definePhase, runOrchestrator } from "turnlock";
import { z } from "zod";
import { readSettings } from "../config/settings.ts";
import { validateCommitMessage } from "../modules/commit-message-validator.ts";
import { runDiscovery } from "../modules/discovery.ts";
import {
	classifyError,
	classifyLLMFailure,
} from "../modules/error-classifier.ts";
import { CommitPlanError, PartialCommitError } from "../modules/errors.ts";
import {
	buildFallbackSettings,
	shouldUseFallback,
} from "../modules/fallback-model.ts";
import {
	executeMultiCommitAndPush,
	formatConventionalCommit,
} from "../modules/git-publisher.ts";
import { processRepoValidationAndDiff } from "../modules/pre-commit-validators.ts";
import {
	MAX_ATTEMPTS_BY_KIND,
	queueRetry,
	retryJobs,
} from "../modules/queue-retry.ts";
import { printReport } from "../modules/reporter.ts";
import type { SkillStatsLog } from "../modules/skill-stats-log.ts";
import { createSkillStatsLog } from "../modules/skill-stats-log.ts";
import type { CommitJobPayload, FeedbackError, GlobalState } from "../types.ts";

// ── Skill stats log ───────────────────────────────────────────────────────

const skillLog: SkillStatsLog = createSkillStatsLog();
let currentRunId = "(unknown)";
const currentParentModel = process.env.PI_PARENT_MODEL || "unknown";
let currentSkillModel = "unknown";
let currentSkillProvider = "unknown";
// Track if run_start has been logged (first delegation only)
let runStarted = false;

// ── Zod schemas ──────────────────────────────────────────────────────────────

const commitMessageSchema = z.object({
	type: z.string(),
	scope: z.string().optional().nullable(),
	description: z.string(),
	body: z.string().optional().nullable(),
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

const ATTEMPT_KINDS = [
	"validation",
	"structural",
	"race",
	"git",
	"network",
] as const;
type AttemptKind = (typeof ATTEMPT_KINDS)[number];

const attemptsSchema = z.preprocess(
	(v) => {
		if (typeof v === "number") return {}; // legacy: zero out
		return v;
	},
	z
		.record(
			z
				.string()
				.refine(
					(k): k is AttemptKind => ATTEMPT_KINDS.includes(k as AttemptKind),
					{
						message: `attempts key must be one of: ${ATTEMPT_KINDS.join(", ")}`,
					},
				),
			z.number().int().nonnegative(),
		)
		.optional(),
);

const stateSchema = z.object({
	repos: z.record(
		z.string(),
		z.object({
			repository: z.string(),
			status: z.enum(["PENDING", "RUNNING", "SUCCESS", "FAILED"]),
			diffHash: z.string().optional(),
			commits: z.array(commitPlanSchema).optional(),
			error: z.string().optional(),
			// CHANGED: per-kind counter (was z.number()); accepts legacy via preprocessor
			attempts: attemptsSchema,
			// NEW: cumulative across retries
			committedShas: z
				.array(z.object({ sha: z.string(), files: z.array(z.string()) }))
				.optional(),
			// NEW
			originalHead: z.string().optional(),
			// NEW: rolling previous_commit history
			feedbackHistory: z.array(z.string()).optional(),
			// NEW: loop detection
			lastPlanHash: z.string().optional(),
			// R62 fix: dedicated loopDetected field
			loopDetected: z
				.object({
					kind: z.string(),
					planHash: z.string(),
				})
				.optional(),
		}),
	),
});

// ── Config ───────────────────────────────────────────────────────────────────

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

			// ── Log run_start on first invocation ───────────────────────────
			currentRunId = io.runId;
			currentSkillModel = settings.model;
			currentSkillProvider = settings.provider;

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
			process.stderr.write("[DEBUG] Starting runDiscovery...\n");
			const repos = await runDiscovery(settings);
			process.stderr.write(
				"[DEBUG] runDiscovery done: " + repos.length + " repos\n",
			);
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
					process.stderr.write("[DEBUG] Validating repo: " + repo.path + "\n");
					const t0 = Date.now();
					const { diff, diffHash } = await processRepoValidationAndDiff(
						repo,
						settings,
					);
					process.stderr.write(
						"[DEBUG] Repo validated in " +
							(Date.now() - t0) +
							"ms: " +
							repo.path +
							"\n",
					);
					validRepos.push({ id: repo.id, path: repo.path, diff, diffHash });
					nextRepos[repo.id] = {
						repository: repo.path,
						status: "PENDING",
						diffHash,
					};
				} catch (err) {
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
				skillLog.logRunEnd({
					runId: currentRunId,
					durationMs: 0,
					model: currentSkillModel,
					successCount: 0,
					failCount: Object.values(nextRepos).filter(
						(r) => r.status === "FAILED",
					).length,
					totalRepos: Object.keys(nextRepos).length,
					totalRetries: 0,
					loopCount: 0,
				});
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
					thinking: settings.thinking,
				};
				return {
					id: r.id,
					prompt: JSON.stringify(payload),
				};
			});

			// Log run_start once per invocation (not on retries back to this phase)
			if (!runStarted) {
				runStarted = true;
				skillLog.logRunStart({
					runId: currentRunId,
					parentModel: currentParentModel,
					skillModel: currentSkillModel,
					skillProvider: currentSkillProvider,
					reposCount: jobs.length,
				});
			}

			for (const r of validRepos) {
				const repoState = nextRepos[r.id];
				if (repoState) {
					repoState.status = "RUNNING";
				}
			}

			return io.delegateAgentBatch(
				{
					kind: "agent-batch",
					agentType: "git-commit-generator",
					label: "commit-jobs",
					jobs,
					timeout: { perDelegationMs: 600_000 },
					retry: { maxAttempts: 1, backoffBaseMs: 1000, maxBackoffMs: 30000 },
				},
				"commit-and-push",
				{ repos: nextRepos },
			);
		}),

		"commit-and-push": definePhase(async (state, io) => {
			const settings = readSettings(path.resolve(__dirname, "../config"));

			// ── Init stats vars for resume flow ────────────────────────────
			currentRunId = io.runId;
			currentSkillModel = settings.model;
			currentSkillProvider = settings.provider;

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
			} catch {
				// ignore
			}

			// Phase 4: Retrieve results
			const results = io.consumePendingBatchResults(commitJobResultSchema);
			const nextRepos = { ...state.repos };

			// Drain any leftover jobs from a previous failed iteration of this phase.
			// R26 invariant: only safe if Turnlock guarantees single-instance execution.
			retryJobs.length = 0;

			// Track accumulated stats for run_end
			let totalRetries = 0;
			let loopCount = 0;

			for (const result of results) {
				let repoState = nextRepos[result.id];
				if (!repoState) continue;

				if (!result.success) {
					// R7 + R27 fix: classify LLM-side failures instead of hardcoding "git"
					const llmKind = classifyLLMFailure(result.error);
					if (llmKind === null) {
						// R57 mirror (C1): if LLM returned empty plans but commits already landed,
						// treat as SUCCESS — same logic as classifyError for CommitPlanError(empty-plans).
						const isLlmEmptyPlans =
							result.error.includes("empty") ||
							result.error.includes("non-empty JSON array");
						const committedShasExist =
							(repoState.committedShas?.length ?? 0) > 0;
						if (isLlmEmptyPlans && committedShasExist) {
							nextRepos[result.id] = {
								...repoState,
								status: "SUCCESS",
								commits: [],
								error:
									"LLM returned an empty plan after partial commits completed; treating as success.",
							};
							continue;
						}
						// Fail-closed for unknown/bridge errors
						nextRepos[result.id] = {
							...repoState,
							status: "FAILED",
							error: `LLM fatal error: ${result.error}`,
						};
						skillLog.logRepoOutcome({
							runId: currentRunId,
							repoId: result.id,
							repository: repoState.repository,
							status: "FAILED",
							error: result.error,
							attempts: repoState.attempts ?? {},
							totalRetries: Object.values(repoState.attempts ?? {}).reduce(
								(a, b) => a + b,
								0,
							),
							loopDetected: undefined,
							committedCount: 0,
						});
						continue;
					}
					// R38 fix: direct access replaces bumpAttempt
					const attempts = repoState.attempts?.[llmKind] ?? 0;
					if (attempts < MAX_ATTEMPTS_BY_KIND[llmKind]) {
						repoState = {
							...repoState,
							attempts: {
								...(repoState.attempts ?? {}),
								[llmKind]: attempts + 1,
							},
						};
						const retryResult = queueRetry(
							result.id,
							repoState,
							[
								{
									kind: llmKind,
									message: result.error,
									resolution_hint:
										"The previous LLM response was malformed. Regenerate based on the current diff.",
								},
							],
							{},
							settings,
							systemPrompt,
							[], // no plans to hash — LLM never returned parseable output
						);
						if (retryResult.kind === "loop-detected") {
							skillLog.logLoopDetected({
								runId: currentRunId,
								repoId: result.id,
								kind: llmKind,
								planHash: retryResult.repoState.lastPlanHash ?? "",
							});
							nextRepos[result.id] = {
								...retryResult.repoState,
								status: "FAILED",
								error: "Loop detected after LLM-side failure.",
							};
							continue;
						}
						totalRetries++;
						skillLog.logRetry({
							runId: currentRunId,
							repoId: result.id,
							kind: llmKind,
							attempt: attempts + 1,
							maxAttempts: MAX_ATTEMPTS_BY_KIND[llmKind],
							diffHash: repoState.diffHash ?? "",
							model: settings.model,
							thinking: settings.thinking ?? false,
						});
						nextRepos[result.id] = retryResult.repoState;
						continue;
					}
					nextRepos[result.id] = {
						...repoState,
						status: "FAILED",
						error: `LLM fatal error after max retries: ${result.error}`,
					};
					skillLog.logRepoOutcome({
						runId: currentRunId,
						repoId: result.id,
						repository: repoState.repository,
						status: "FAILED",
						error: result.error,
						attempts: repoState.attempts ?? {},
						totalRetries: Object.values(repoState.attempts ?? {}).reduce(
							(a, b) => a + b,
							0,
						),
						loopDetected: undefined,
						committedCount: repoState.committedShas?.length ?? 0,
					});
					continue;
				}

				// 1. Validation phase — uses its own per-kind counter (validation)
				const validationErrors: FeedbackError[] = [];
				for (const plan of result.commits) {
					const msgStr = formatConventionalCommit(plan.commit);
					const valRes = validateCommitMessage(msgStr);
					if (!valRes.valid) {
						for (const e of valRes.errors) {
							validationErrors.push({
								kind: "validation",
								message: `[${msgStr}] ${e}`,
								resolution_hint:
									"Rewrite the commit message to comply with Conventional Commits.",
							});
						}
					}
				}
				const validationAttempts = repoState.attempts?.validation ?? 0;
				if (
					validationErrors.length > 0 &&
					validationAttempts < MAX_ATTEMPTS_BY_KIND.validation
				) {
					repoState = {
						...repoState,
						attempts: {
							...(repoState.attempts ?? {}),
							validation: validationAttempts + 1,
						},
					};
					// R11 fix: pass the plan structure, not formatted messages
					const retryResult = queueRetry(
						result.id,
						repoState,
						validationErrors,
						{},
						settings,
						systemPrompt,
						result.commits,
					);
					totalRetries++;
					skillLog.logRetry({
						runId: currentRunId,
						repoId: result.id,
						kind: "validation",
						attempt: validationAttempts + 1,
						maxAttempts: MAX_ATTEMPTS_BY_KIND.validation,
						diffHash: repoState.diffHash ?? "",
						model: settings.model,
						thinking: settings.thinking ?? false,
					});
					if (retryResult.kind === "loop-detected") {
						nextRepos[result.id] = {
							...retryResult.repoState,
							status: "FAILED",
							error: `Loop detected: LLM returned an identical plan on two consecutive attempts for kind "validation".`,
						};
						continue;
					}
					nextRepos[result.id] = retryResult.repoState;
					continue;
				}
				if (validationErrors.length > 0) {
					// Try fallback model before failing
					if (
						shouldUseFallback(
							settings,
							"validation",
							validationAttempts,
							repoState.fallbackAttempted ?? false,
						)
					) {
						const fallbackSettings = buildFallbackSettings(settings);
						const retryResult = queueRetry(
							result.id,
							{
								...repoState,
								fallbackAttempted: true,
								attempts: {
									...(repoState.attempts ?? {}),
									validation: 0, // reset budget for fallback
								},
							},
							validationErrors,
							{},
							fallbackSettings, // override provider/model
							systemPrompt,
							result.commits,
						);
						totalRetries++;
						skillLog.logRetry({
							runId: currentRunId,
							repoId: result.id,
							kind: "validation",
							attempt: 1,
							maxAttempts: MAX_ATTEMPTS_BY_KIND.validation,
							diffHash: repoState.diffHash ?? "",
							model: fallbackSettings.model,
							thinking: settings.thinking ?? false,
						});
						if (retryResult.kind === "loop-detected") {
							nextRepos[result.id] = {
								...retryResult.repoState,
								status: "FAILED",
								error: `Loop detected after fallback: LLM returned an identical plan.`,
							};
							continue;
						}
						nextRepos[result.id] = retryResult.repoState;
						continue;
					}

					nextRepos[result.id] = {
						...repoState,
						status: "FAILED",
						error: `Validation failed after max retries: ${validationErrors.map((e) => e.message).join(", ")}`,
					};
					continue;
				}

				// 2. Execution + error classification
				if (!repoState.diffHash) {
					throw new Error(`Cannot push: diffHash missing for ${result.id}`);
				}

				try {
					const { committedShas, originalHead } =
						await executeMultiCommitAndPush(
							repoState.repository,
							result.commits,
							repoState.diffHash,
							settings,
						);
					// Merge with anything that landed in prior retries
					repoState = {
						...repoState,
						committedShas: [
							...(repoState.committedShas ?? []),
							...committedShas,
						],
						originalHead,
					};
					nextRepos[result.id] = {
						...repoState,
						status: "SUCCESS",
						commits: result.commits,
					};
				} catch (err) {
					// R59 fix (C3): merge err.context.committedShas before checking
					let pendingFiles: string[] | undefined;
					if (err instanceof PartialCommitError) {
						repoState = {
							...repoState,
							committedShas: [
								...(repoState.committedShas ?? []),
								...err.context.committedShas,
							],
							originalHead: err.context.originalHead,
						};
						pendingFiles = err.context.pendingFiles;
					} else if (
						err instanceof CommitPlanError &&
						err.context?.committedShas?.length
					) {
						repoState = {
							...repoState,
							committedShas: [
								...(repoState.committedShas ?? []),
								...err.context.committedShas,
							],
						};
						pendingFiles = err.context.pendingFiles;
					}

					const committedShasExist = (repoState.committedShas?.length ?? 0) > 0;
					const classified = classifyError(err, committedShasExist);

					// R57 fix (C1): empty-plans with committedShas = SUCCESS
					if (classified.kind === "success") {
						nextRepos[result.id] = {
							...repoState,
							status: "SUCCESS",
							commits: [],
							error:
								"LLM returned an empty plan after partial commits completed; treating as success.",
						};
						continue;
					}

					const errKind = classified.error.kind;
					const attempts = repoState.attempts?.[errKind] ?? 0;
					const maxAttempts = MAX_ATTEMPTS_BY_KIND[errKind];

					if (classified.kind === "retry" && attempts < maxAttempts) {
						// R74 fix: re-attempt git reset HEAD before queuing retry
						try {
							execSync("git reset HEAD", {
								cwd: repoState.repository,
								encoding: "utf-8",
								stdio: ["pipe", "pipe", "pipe"],
							});
						} catch (resetErr) {
							process.stderr.write(
								`[git-commits-push-tl] orchestrator reset HEAD failed during retry prep: ` +
									`${resetErr instanceof Error ? resetErr.message : String(resetErr)}\n`,
							);
						}

						repoState = {
							...repoState,
							attempts: {
								...(repoState.attempts ?? {}),
								[errKind]: attempts + 1,
							},
						};

						const retryResult = queueRetry(
							result.id,
							repoState,
							[classified.error],
							{ committedShas: repoState.committedShas, pendingFiles },
							settings,
							systemPrompt,
							result.commits,
						);

						if (retryResult.kind === "loop-detected") {
							loopCount++;
							skillLog.logLoopDetected({
								runId: currentRunId,
								repoId: result.id,
								kind: errKind,
								planHash: retryResult.repoState.lastPlanHash ?? "",
							});
							nextRepos[result.id] = {
								...retryResult.repoState,
								status: "FAILED",
								error: `Loop detected: LLM returned an identical plan on two consecutive attempts for kind "${errKind}".`,
								loopDetected: {
									kind: errKind,
									planHash: retryResult.repoState.lastPlanHash ?? "",
								},
							};
							skillLog.logRepoOutcome({
								runId: currentRunId,
								repoId: result.id,
								repository: repoState.repository,
								status: "FAILED",
								error: `Loop detected for kind ${errKind}`,
								attempts: repoState.attempts ?? {},
								totalRetries: Object.values(repoState.attempts ?? {}).reduce(
									(a, b) => a + b,
									0,
								),
								loopDetected: {
									kind: errKind,
									planHash: retryResult.repoState.lastPlanHash ?? "",
								},
								committedCount: repoState.committedShas?.length ?? 0,
							});
							continue;
						}

						totalRetries++;
						skillLog.logRetry({
							runId: currentRunId,
							repoId: result.id,
							kind: errKind,
							attempt: attempts + 1,
							maxAttempts: MAX_ATTEMPTS_BY_KIND[errKind],
							diffHash: repoState.diffHash ?? "",
							model: settings.model,
							thinking: settings.thinking ?? false,
						});
						nextRepos[result.id] = retryResult.repoState;
						continue;
					}

					nextRepos[result.id] = {
						...repoState,
						status: "FAILED",
						error: classified.error.message,
					};
					skillLog.logRepoOutcome({
						runId: currentRunId,
						repoId: result.id,
						repository: repoState.repository,
						status: "FAILED",
						error: classified.error.message,
						attempts: repoState.attempts ?? {},
						totalRetries: Object.values(repoState.attempts ?? {}).reduce(
							(a, b) => a + b,
							0,
						),
						loopDetected: undefined,
						committedCount: repoState.committedShas?.length ?? 0,
					});
				}
			}

			if (retryJobs.length > 0) {
				const jobsSnapshot = retryJobs.slice();
				return io.delegateAgentBatch(
					{
						kind: "agent-batch",
						agentType: "git-commit-generator",
						label: `commit-jobs-retry-${Date.now()}`, // unique per retry
						jobs: jobsSnapshot,
						timeout: { perDelegationMs: 600_000 },
						retry: {
							maxAttempts: 1,
							backoffBaseMs: 1000,
							maxBackoffMs: 30000,
						},
					},
					"commit-and-push",
					{ repos: nextRepos },
				);
			}

			// Phase 5: Reporting
			printReport(nextRepos);

			const successCount = Object.values(nextRepos).filter(
				(r) => r.status === "SUCCESS",
			).length;
			const failCount = Object.values(nextRepos).filter(
				(r) => r.status === "FAILED",
			).length;
			const totalRepos = Object.keys(nextRepos).length;

			skillLog.logRunEnd({
				runId: currentRunId,
				durationMs: Date.now() - (io.clock?.now?.() ?? Date.now()),
				model: currentSkillModel,
				successCount,
				failCount,
				totalRepos,
				totalRetries,
				loopCount,
			});

			const hasFailedRepo = failCount > 0;
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
