/**
 * Helpers available exclusively to tests.
 *
 * They seed the persisted Turnlock v2 state used by resume-path tests. The
 * fixture intentionally mirrors the runtime's post-delegation snapshot so
 * tests exercise the real resume path rather than a legacy approximation.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_SCHEMA_VERSION } from "turnlock";
import type { CommitJobResult, GlobalState } from "../../src/types.ts";

interface PendingBatchDelegationRecord {
	readonly label: string;
	readonly kind: "batch";
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
	/** Required for batch delegations because Turnlock derives result paths from it. */
	readonly jobIds: readonly string[];
}

interface TurnlockV2StateFile {
	readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
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
	readonly pendingDelegation: PendingBatchDelegationRecord;
	readonly usedLabels: readonly string[];
}

interface TurnlockV2BatchManifest {
	readonly manifestVersion: 2;
	readonly runId: string;
	readonly orchestratorName: string;
	readonly phase: string;
	readonly resumeAt: string;
	readonly label: string;
	readonly kind: "batch";
	readonly emittedAt: string;
	readonly emittedAtEpochMs: number;
	readonly timeoutMs: number;
	readonly deadlineAtEpochMs: number;
	readonly attempt: number;
	readonly maxAttempts: number;
	readonly worker: string;
	readonly jobs: readonly {
		readonly id: string;
		readonly prompt: string;
		readonly resultPath: string;
	}[];
}

/**
 * Writes the state.json and v2 batch manifest that Turnlock persists after
 * `discovery-and-validation` delegates to `commit-and-push`.
 */
export function computeStateJson(
	runDir: string,
	state: GlobalState,
	runId: string = "test-run-seeded",
): void {
	const now = Date.now();
	const nowIso = new Date(now).toISOString();
	const label = "commit-jobs";
	const timeoutMs = 600_000;
	const maxAttempts = 1;
	const repoIds = Object.keys(state.repos);
	const turnlockRunDir = path.join(
		runDir,
		"runs",
		"git-commits-push-tl",
		runId,
	);
	const delegationsDir = path.join(turnlockRunDir, "delegations");
	const resultsBatchDir = path.join(turnlockRunDir, "results", `${label}-0`);
	const manifestPath = path.join(delegationsDir, `${label}-0.json`);

	fs.mkdirSync(delegationsDir, { recursive: true });
	fs.mkdirSync(resultsBatchDir, { recursive: true });

	const jobs = repoIds.map((id) => ({
		id,
		prompt: JSON.stringify({ repository: state.repos[id]?.repository ?? "" }),
		resultPath: path.join(resultsBatchDir, `${id}.json`),
	}));

	const manifest: TurnlockV2BatchManifest = {
		manifestVersion: 2,
		runId,
		orchestratorName: "git-commits-push-tl",
		phase: "discovery-and-validation",
		resumeAt: "commit-and-push",
		label,
		kind: "batch",
		emittedAt: nowIso,
		emittedAtEpochMs: now,
		timeoutMs,
		deadlineAtEpochMs: now + timeoutMs,
		attempt: 0,
		maxAttempts,
		worker: "git-commit-generator",
		jobs,
	};

	const stateFile: TurnlockV2StateFile = {
		schemaVersion: STATE_SCHEMA_VERSION,
		runId,
		orchestratorName: "git-commits-push-tl",
		startedAt: nowIso,
		startedAtEpochMs: now,
		lastTransitionAt: nowIso,
		lastTransitionAtEpochMs: now,
		currentPhase: "discovery-and-validation",
		phasesExecuted: 1,
		accumulatedDurationMs: 0,
		data: state,
		pendingDelegation: {
			label,
			kind: "batch",
			resumeAt: "commit-and-push",
			manifestPath,
			emittedAtEpochMs: now,
			deadlineAtEpochMs: now + timeoutMs,
			attempt: 0,
			effectiveRetryPolicy: {
				maxAttempts,
				backoffBaseMs: 1000,
				maxBackoffMs: 30_000,
			},
			jobIds: repoIds,
		},
		usedLabels: [label],
	};

	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
	fs.writeFileSync(
		path.join(turnlockRunDir, "state.json"),
		JSON.stringify(stateFile, null, 2),
	);
}

/**
 * Write a single job's LLM result to the location expected by Turnlock.
 * This must be called after computeStateJson so the directory exists.
 */
export function writeLLMResultToTurnlockRunDir(
	mockEnvRunDir: string,
	jobId: string,
	result: CommitJobResult,
	runId: string = "test-run-seeded",
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
