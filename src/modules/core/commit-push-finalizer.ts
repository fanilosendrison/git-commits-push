import * as fs from "node:fs";
import * as path from "node:path";
import type { PhaseIO, PhaseResult } from "turnlock";
import type { GlobalState, RepoState } from "../../types.ts";
import type { SkillStatsLog } from "../telemetry/stats-events.ts";
import { printReport } from "./reporter.ts";

/** Print final results, emit terminal telemetry, and finish the Turnlock phase. */
export function finalizeCommitPushPhase(
	nextRepos: Record<string, RepoState>,
	io: PhaseIO<GlobalState>,
	runId: string,
	loopCount: number,
	skillLog: SkillStatsLog,
): PhaseResult<GlobalState, unknown> {
	printReport(nextRepos);

	const successCount = Object.values(nextRepos).filter(
		(repoState) => repoState.status === "SUCCESS",
	).length;
	const failCount = Object.values(nextRepos).filter(
		(repoState) => repoState.status === "FAILED",
	).length;
	const totalRepos = Object.keys(nextRepos).length;
	const totalRetries = Object.values(nextRepos).reduce(
		(sum, repoState) =>
			sum +
			Object.values(repoState.attempts ?? {}).reduce(
				(repoSum, count) => repoSum + count,
				0,
			),
		0,
	);

	let startEpoch = Date.now();
	try {
		const statePath = path.join(io.runDir, "state.json");
		const rawState = fs.readFileSync(statePath, "utf-8");
		const parsedState = JSON.parse(rawState) as { startedAtEpochMs?: number };
		startEpoch = parsedState.startedAtEpochMs ?? startEpoch;
	} catch {
		// The final report remains valid when legacy state has no start timestamp.
	}

	skillLog.logRunEnd({
		runId,
		durationMs: Date.now() - startEpoch,
		successCount,
		failCount,
		totalRepos,
		totalRetries,
		loopCount,
	});
	skillLog.logRequestFinished({
		runId,
		outcome: failCount > 0 ? "failed" : "success",
		successCount,
		failCount,
		totalRepos,
		totalRetries,
	});

	if (failCount > 0) {
		return io.fail(
			new Error(
				"One or more repositories failed to publish commits. Check report.",
			),
		);
	}
	return io.done({});
}
