import * as fs from "node:fs";
import * as path from "node:path";
import type { PhaseIO, PhaseResult } from "turnlock";
import { readSettings } from "../config/settings.ts";
import { runDiscovery } from "../modules/core/discovery.ts";
import { printReport } from "../modules/core/reporter.ts";
import { processRepoValidationAndDiff } from "../modules/core/validators/pre-commit-validators.ts";
import { createSkillStatsLog } from "../modules/telemetry/stats-logger.ts";
import type { CommitJobPayload, GlobalState } from "../types.ts";
import { releaseLockAndTriggerNext } from "../utils/lock-manager.ts";

const skillLog = createSkillStatsLog();
const currentParentModel = process.env.PI_PARENT_MODEL || "unknown";
let runStarted = false;
let runStartEpochMs = 0;

export async function runDiscoveryAndValidationPhase(
	state: GlobalState,
	io: PhaseIO<GlobalState>,
): Promise<PhaseResult<GlobalState, unknown>> {
	const settings = readSettings(path.resolve(import.meta.dir, "../config"));

	// ── Log run_start on first invocation ───────────────────────────
	const currentRunId = io.runId;
	const currentSkillModel = settings.model;
	const currentSkillProvider = settings.provider;

	// Try to read system prompt if present, else empty string
	let systemPrompt = "";
	try {
		const promptPath = path.resolve(
			import.meta.dir,
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
	process.stderr.write(`[DEBUG] runDiscovery done: ${repos.length} repos\n`);
	if (repos.length === 0) {
		process.stderr.write(
			"[orchestrator] No repositories with changes found. Exiting.\n",
		);
		printReport({});
		skillLog.logOrderFinished({
			runId: currentRunId,
			outcome: "no_changes",
			successCount: 0,
			failCount: 0,
			totalRepos: 0,
			totalRetries: 0,
		});
		releaseLockAndTriggerNext(io.runId);
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
			process.stderr.write(`[DEBUG] Validating repo: ${repo.path}\n`);
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
				status: "PENDING" as const,
				diffHash,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			nextRepos[repo.id] = {
				repository: repo.path,
				status: "FAILED" as const,
				error: msg,
			};
		}
	}

	if (validRepos.length === 0) {
		process.stderr.write(
			"[orchestrator] No repositories passed validation. Exiting.\n",
		);
		const failCount = Object.values(nextRepos).filter(
			(r) => r.status === "FAILED",
		).length;
		const totalRepos = Object.keys(nextRepos).length;
		printReport(nextRepos);
		skillLog.logRunEnd({
			runId: currentRunId,
			durationMs: Date.now() - runStartEpochMs,
			successCount: 0,
			failCount,
			totalRepos,
			totalRetries: 0,
			loopCount: 0,
		});
		skillLog.logOrderFinished({
			runId: currentRunId,
			outcome: failCount > 0 ? "failed" : "no_valid_repos",
			successCount: 0,
			failCount,
			totalRepos,
			totalRetries: 0,
		});
		releaseLockAndTriggerNext(io.runId);
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
			agent: settings.agent,
		};
		return {
			id: r.id,
			prompt: JSON.stringify(payload),
		};
	});

	// Log run_start once per invocation (not on retries back to this phase)
	if (!runStarted) {
		runStarted = true;
		runStartEpochMs = Date.now();
		skillLog.logRunStart({
			runId: currentRunId,
			parentModel: currentParentModel,
			skillModel: currentSkillModel,
			skillProvider: currentSkillProvider,
			reposCount: jobs.length,
			thinking: settings.thinking ?? false,
		});
	}

	for (const r of validRepos) {
		const repoState = nextRepos[r.id];
		if (repoState) {
			repoState.status = "RUNNING";
		}
	}

	// Log initial delegation per repo
	for (const r of validRepos) {
		skillLog.logDelegation({
			runId: currentRunId,
			repoId: r.id,
			repository: r.path,
			isRetry: false,
			retryKind: null,
			attempt: 0,
			model: currentSkillModel,
			thinking: settings.thinking ?? false,
			diffHash: r.diffHash,
			diffSizeBytes: Buffer.byteLength(r.diff, "utf-8"),
			previousDiffHash: null,
			diffChanged: null,
			pendingFilesCount: null,
			feedbackHistoryItems: 0,
		});
	}

	return io.delegateBatch(
		{
			kind: "batch",
			worker: "git-commit-generator",
			label: "commit-jobs",
			jobs,
			timeout: { perDelegationMs: 600_000 },
			retry: { maxAttempts: 1, backoffBaseMs: 1000, maxBackoffMs: 30000 },
		},
		"commit-and-push",
		{ repos: nextRepos },
	);
}
