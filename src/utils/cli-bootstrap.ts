/**
 * src/utils/cli-bootstrap.ts — Pre-Turnlock bootstrap for direct orchestrator runs.
 *
 * The global reconciler (scripts/start-node.mjs) owns admission, heartbeat and
 * pass scheduling. This bootstrap only guarantees that every orchestrator
 * execution has a fresh Turnlock run id and a request identity for telemetry.
 */
import { createRunId } from "../modules/orders/order-id.ts";
import { resolveRequestIdentity } from "../modules/orders/request-identity.ts";
import type { RequestIdentity } from "../modules/orders/types.ts";
import { createSkillStatsLog } from "../modules/telemetry/stats-logger.ts";

function logRequestStarted(runId: string, identity: RequestIdentity): void {
	try {
		createSkillStatsLog().logRequestStarted({
			requestId: identity.requestId,
			runId,
			callerName: identity.callerName,
			originAgent: identity.originAgent,
			...(identity.originSessionId
				? { originSessionId: identity.originSessionId }
				: {}),
		});
	} catch {
		// Telemetry must not block the orchestrator from starting.
	}
}

export function bootstrapOrchestratorRun(args: string[]): void {
	const isResume = args.includes("--resume");
	const runIdIdx = args.indexOf("--run-id");
	const argRunId = runIdIdx !== -1 ? args[runIdIdx + 1] : undefined;

	if (isResume) {
		return;
	}

	let runId = argRunId ?? "";
	if (!runId) {
		runId = createRunId();
		process.argv.push("--run-id", runId);
	}

	const identity = resolveRequestIdentity();
	logRequestStarted(runId, identity);
}
