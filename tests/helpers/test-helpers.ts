/**
 * src/test-helpers.ts — Helpers available exclusively to tests.
 * Writes pre-seeded Turnlock state files to simulate a completed Phase 3
 * so that resume-path tests (A2, P1, P3, P4, I2) can start from Phase 4.
 *
 * The StateFile format mirrors exactly what Turnlock's state-io.ts expects.
 * Validated against: turnlock/src/services/state-io.ts (schemaVersion: 1).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { GlobalState, CommitJobResult } from "../../src/types.ts";

interface PendingDelegationRecord {
	readonly label: string;
	readonly kind: "agent-batch";
	readonly resumeAt: string;
	readonly manifestPath: string;
	readonly emittedAtEpochMs: number;
	readonly deadlineAtEpochMs: number;
	readonly attempt: number;
	readonly effectiveRetryPolicy: {
		readonly maxAttempts: number;
		readonly backoffBaseMs: number;
		readonly maxBackoffMs: number;
	};
	readonly jobIds: readonly string[];
}

interface StateFile {
	readonly schemaVersion: 1;
	readonly runId: string;
	readonly orchestratorName: string;
	readonly startedAt: string;
	readonly startedAtEpochMs: number;
	readonly lastTransitionAt: string;
	readonly lastTransitionAtEpochMs: number;
	readonly currentPhase: string;
	readonly phasesExecuted: number;
	readonly accumulatedDurationMs: number;
	readonly data: GlobalState;
	readonly pendingDelegation: PendingDelegationRecord;
	readonly usedLabels: readonly string[];
}

/**
 * Writes a state.json + the delegations directory into the runDir,
 * simulating what Turnlock writes after emitting a DELEGATE block during Phase 3.
 *
 * The manifest written here is a minimal agent-batch manifest compatible with
 * what Turnlock's handle-resume.ts expects to find at pd.manifestPath.
 */
export function computeStateJson(runDir: string, state: GlobalState, runId: string = "test-run-seeded"): void {
	const now = Date.now();
	const nowIso = new Date(now).toISOString();
	const repoIds = Object.keys(state.repos);

	// Build a minimal manifest file for the pending delegation
	const delegationsDir = path.join(runDir, "delegations");
	fs.mkdirSync(delegationsDir, { recursive: true });
	const manifestPath = path.join(delegationsDir, "commit-jobs-0.json");

	const jobs = repoIds.map((id) => ({
		id,
		prompt: JSON.stringify({ repository: state.repos[id]?.repository ?? "" }),
		resultPath: path.join(runDir, "results", "commit-jobs-0", `${id}.json`),
	}));

	const manifest = {
		kind: "agent-batch",
		agentType: "git-commit-generator",
		label: "commit-jobs",
		runId,
		orchestrator: "git-commits-push-tl",
		resumeCommand: `bun run src/turnlock-orchestrator.ts --resume --run-id ${runId}`,
		timeoutMs: 600_000,
		emittedAt: nowIso,
		emittedAtEpochMs: now,
		deadlineAtEpochMs: now + 600_000,
		attempt: 0,
		jobs,
	};
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

	// Ensure results directory exists
	const resultsBatchDir = path.join(runDir, "results", "commit-jobs-0");
	fs.mkdirSync(resultsBatchDir, { recursive: true });

	const stateFile: StateFile = {
		schemaVersion: 1,
		runId,
		orchestratorName: "git-commits-push-tl",
		startedAt: nowIso,
		startedAtEpochMs: now,
		lastTransitionAt: nowIso,
		lastTransitionAtEpochMs: now,
		currentPhase: "commit-and-push",
		phasesExecuted: 1,
		accumulatedDurationMs: 0,
		data: state,
		pendingDelegation: {
			label: "commit-jobs",
			kind: "agent-batch",
			resumeAt: "commit-and-push",
			manifestPath,
			emittedAtEpochMs: now,
			deadlineAtEpochMs: now + 600_000,
			attempt: 0,
			effectiveRetryPolicy: {
				maxAttempts: 1,
				backoffBaseMs: 1000,
				maxBackoffMs: 30_000,
			},
			jobIds: repoIds,
		},
		usedLabels: ["commit-jobs"],
	};

	// Write state.json in the exact location Turnlock expects: <runDir>/state.json
	// But our runDir from tests is the mock env's base dir; Turnlock writes to:
	// <TURNLOCK_RUN_DIR_ROOT>/git-commits-push-TL/<runId>/state.json
	// We create that full path here so the resume subprocess finds it.
	const turnlockRunDir = path.join(runDir, "runs", "git-commits-push-tl", runId);
	fs.mkdirSync(turnlockRunDir, { recursive: true });
	fs.mkdirSync(path.join(turnlockRunDir, "delegations"), { recursive: true });
	fs.mkdirSync(path.join(turnlockRunDir, "results"), { recursive: true });

	// Copy manifest to the Turnlock run dir location
	const tlManifestPath = path.join(turnlockRunDir, "delegations", "commit-jobs-0.json");
	fs.copyFileSync(manifestPath, tlManifestPath);

	// Rewrite manifest path reference in state to point to TL run dir
	const tlResultsBatchDir = path.join(turnlockRunDir, "results", "commit-jobs-0");
	fs.mkdirSync(tlResultsBatchDir, { recursive: true });

	const tlJobs = repoIds.map((id) => ({
		id,
		prompt: JSON.stringify({ repository: state.repos[id]?.repository ?? "" }),
		resultPath: path.join(tlResultsBatchDir, `${id}.json`),
	}));
	const tlManifest = { ...manifest, jobs: tlJobs };
	fs.writeFileSync(tlManifestPath, JSON.stringify(tlManifest, null, 2));

	const finalState: StateFile = {
		...stateFile,
		pendingDelegation: {
			...stateFile.pendingDelegation,
			manifestPath: tlManifestPath,
			jobIds: repoIds,
		},
	};
	fs.writeFileSync(path.join(turnlockRunDir, "state.json"), JSON.stringify(finalState, null, 2));
}

/**
 * Write a single job's LLM result to the location expected by Turnlock.
 * This must be called AFTER computeStateJson so the directory exists.
 */
export function writeLLMResultToTurnlockRunDir(
	mockEnvRunDir: string,
	jobId: string,
	result: CommitJobResult,
	runId: string = "test-run-seeded"
): void {
	const resultPath = path.join(
		mockEnvRunDir,
		"runs",
		"git-commits-push-tl",
		runId,
		"results",
		"commit-jobs-0",
		`${jobId}.json`,
	);
	fs.mkdirSync(path.dirname(resultPath), { recursive: true });
	fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
}
