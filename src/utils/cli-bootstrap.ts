import {
	checkAndAcquireLock,
	startHeartbeat,
	setupCleanupHooks,
} from "./order.ts";

export function bootstrapOrchestratorRun(args: string[]): void {
	const isResume = args.includes("--resume");
	let runId = "";
	const runIdIdx = args.indexOf("--run-id");
	const argRunId = runIdIdx !== -1 ? args[runIdIdx + 1] : undefined;
	if (argRunId) {
		runId = argRunId;
	}

	if (!isResume) {
		if (!runId) {
			const d = new Date();
			const formattedDate = d.toISOString().replace(/[:.-]/g, "").toLowerCase();
			runId = `run-${formattedDate}-${Math.random().toString(36).substring(2, 6)}`;
			process.argv.push("--run-id", runId);
		}

		let callerName = "CLI/User";
		if (process.env.PI_AGENT === "1" || process.env.PI_SESSION_ID) {
			callerName = "Pi Agent";
		} else if (process.env.CLAUDE_CODE === "1") {
			callerName = "Claude Code";
		} else if (process.env.ANTIGRAVITY_AGENT === "1") {
			callerName = "Antigravity Agent";
		} else if (process.env.USER) {
			callerName = process.env.USER;
		}

		const lockResult = checkAndAcquireLock(runId, callerName);
		if (lockResult === "QUEUED") {
			process.exit(0);
		}

		startHeartbeat();
		setupCleanupHooks(runId);
	} else {
		if (runId) {
			startHeartbeat();
			setupCleanupHooks(runId);
		}
	}
}
