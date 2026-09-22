/**
 * src/utils/cli-bootstrap.ts — Pre-Turnlock bootstrap for direct orchestrator runs.
 *
 * The public launcher's reconciliation module owns admission, heartbeat and
 * pass scheduling. This bootstrap only guarantees that every orchestrator
 * execution has a fresh Turnlock run id and a request identity for telemetry.
 */
import {
	GLOBAL_INVOCATION_SCOPE,
	parseInvocationArguments,
	resolveInvocationScope,
} from "../modules/invocation/invocation-scope.ts";
import { createRunId } from "../modules/orders/order-id.ts";
import { resolveRequestIdentity } from "../modules/orders/request-identity.ts";
import type { RequestIdentity } from "../modules/orders/types.ts";
import { createSkillStatsLog } from "../modules/telemetry/stats-logger.ts";
import type { InvocationScope } from "../types.ts";

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

export function bootstrapOrchestratorRun(
	args: readonly string[],
): InvocationScope {
	const parsed = parseInvocationArguments(args);
	process.argv.splice(
		2,
		process.argv.length - 2,
		...parsed.passthroughArguments,
	);
	const invocationScope = resolveInvocationScope(parsed.request);

	const isResume = parsed.passthroughArguments.includes("--resume");
	const runIdIdx = parsed.passthroughArguments.indexOf("--run-id");
	const argRunId =
		runIdIdx !== -1 ? parsed.passthroughArguments[runIdIdx + 1] : undefined;

	if (isResume) {
		// Resume never redefines scope: the parser rejects targeted flags with
		// --resume, and persisted Turnlock state overrides this fallback.
		return GLOBAL_INVOCATION_SCOPE;
	}

	let runId = argRunId ?? "";
	if (!runId) {
		runId = createRunId();
		process.argv.push("--run-id", runId);
	}

	const identity = resolveRequestIdentity();
	logRequestStarted(runId, identity);

	return invocationScope;
}
