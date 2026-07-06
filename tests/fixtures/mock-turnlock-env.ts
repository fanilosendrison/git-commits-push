import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CommitJobResult, Settings } from "../../src/types.ts";

/**
 * MockTurnlockEnvironment — NIB-T §2
 * Simulates the on-disk state that Turnlock would normally create and inject
 * into a skill's environment before invoking it.
 *
 * The directory layout mirrors what runOrchestrator() produces:
 *   <runDir>/
 *     settings.json
 *     state.json                       (written by Turnlock after DELEGATE)
 *     delegations/commit-jobs-0.json   (manifest written by Turnlock)
 *     results/
 *       commit-jobs-0/
 *         <jobId>.json                 (written by the Pi wrapper)
 */
export class MockTurnlockEnvironment {
	readonly runDir: string;
	/** Isolated temp dir for skill-stats-log (keeps tests out of production events.jsonl) */
	readonly statsDir: string;

	private constructor(runDir: string, statsDir: string) {
		this.runDir = runDir;
		this.statsDir = statsDir;
	}

	/** Create a fresh, isolated runDir under the system temp dir */
	static create(): MockTurnlockEnvironment {
		const runDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "git-commits-push-tl-run-"),
		);
		const statsDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "git-commits-push-stats-"),
		);
		const env = new MockTurnlockEnvironment(runDir, statsDir);
		fs.mkdirSync(path.join(runDir, "delegations"), { recursive: true });
		fs.mkdirSync(path.join(runDir, "results"), { recursive: true });
		return env;
	}

	/** Environment variables to pass to spawnSync (Turnlock + stats isolation) */
	env(): Record<string, string> {
		return {
			TURNLOCK_RUN_DIR_ROOT: path.join(this.runDir, "runs"),
			TURNLOCK_SKILL_SETTINGS_PATH: path.join(this.runDir, "settings.json"),
			PI_SKILL_STATS_DIR: this.statsDir,
			SECRET_SCANNER_STATS_DIR: this.statsDir,
		};
	}

	writeSettings(settings: Settings): void {
		fs.writeFileSync(
			path.join(this.runDir, "settings.json"),
			JSON.stringify(settings, null, 2),
			"utf-8",
		);
	}

	/**
	 * Write a single job's LLM result to its per-job file.
	 * Path convention: runs/git-commits-push-tl/<runId>/results/commit-jobs-0/<jobId>.json
	 * jobId must match the repository ID used in the delegation batch.
	 */
	writeLLMResult(
		jobId: string,
		result: CommitJobResult,
		runId: string = "test-run-seeded",
	): void {
		const batchDir = path.join(
			this.runDir,
			"runs",
			"git-commits-push-tl",
			runId,
			"results",
			"commit-jobs-0",
		);
		fs.mkdirSync(batchDir, { recursive: true });
		fs.writeFileSync(
			path.join(batchDir, `${jobId}.json`),
			JSON.stringify(result, null, 2),
			"utf-8",
		);
	}

	dispose(): void {
		fs.rmSync(this.runDir, { recursive: true, force: true });
		fs.rmSync(this.statsDir, { recursive: true, force: true });
	}
}
