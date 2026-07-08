import { createOrderId, createRunId } from "../modules/orders/order-id.ts";
import { ORDER_ENV_KEYS, type OrderContext } from "../modules/orders/types.ts";
import { createSkillStatsLog } from "../modules/telemetry/stats-logger.ts";
import {
	checkAndAcquireLock,
	setupCleanupHooks,
	startHeartbeat,
} from "./lock-manager.ts";

function getCallerName(): string {
	if (process.env[ORDER_ENV_KEYS.callerName]) {
		return process.env[ORDER_ENV_KEYS.callerName] ?? "CLI/User";
	}
	if (process.env.PI_AGENT === "1" || process.env.PI_SESSION_ID) {
		return "Pi Agent";
	}
	if (process.env.CLAUDE_CODE === "1") {
		return "Claude Code";
	}
	if (process.env.ANTIGRAVITY_AGENT === "1") {
		return "Antigravity Agent";
	}
	if (process.env.USER) {
		return process.env.USER;
	}
	return "CLI/User";
}

function getOriginAgent(): string {
	if (process.env[ORDER_ENV_KEYS.originAgent]) {
		return process.env[ORDER_ENV_KEYS.originAgent] ?? "unknown";
	}
	if (process.env.PI_AGENT === "1" || process.env.PI_SESSION_ID) {
		return "pi";
	}
	if (process.env.CLAUDE_CODE === "1") {
		return "claude";
	}
	if (process.env.ANTIGRAVITY_AGENT === "1") {
		return "antigravity";
	}
	return "cli";
}

function getOriginSessionId(): string | undefined {
	return (
		process.env[ORDER_ENV_KEYS.originSessionId] ??
		process.env.PI_SESSION_ID ??
		process.env.ANTIGRAVITY_TRAJECTORY_ID
	);
}

function getOptionalNumberEnv(key: string): number | undefined {
	const value = process.env[key];
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function buildOrderContext(): OrderContext {
	const orderId = process.env[ORDER_ENV_KEYS.orderId] ?? createOrderId();
	const callerName = getCallerName();
	const originAgent = getOriginAgent();
	const originSessionId = getOriginSessionId();
	const queuedAtEpochMs = getOptionalNumberEnv(ORDER_ENV_KEYS.queuedAtEpochMs);
	const triggeredByRunId = process.env[ORDER_ENV_KEYS.triggeredByRunId];
	const isQueuedOrder = process.env[ORDER_ENV_KEYS.isQueuedOrder] === "1";

	process.env[ORDER_ENV_KEYS.orderId] = orderId;
	process.env[ORDER_ENV_KEYS.callerName] = callerName;
	process.env[ORDER_ENV_KEYS.originAgent] = originAgent;
	if (originSessionId) {
		process.env[ORDER_ENV_KEYS.originSessionId] = originSessionId;
	}

	return {
		orderId,
		callerName,
		originAgent,
		isQueuedOrder,
		...(originSessionId ? { originSessionId } : {}),
		...(queuedAtEpochMs ? { queuedAtEpochMs } : {}),
		...(triggeredByRunId ? { triggeredByRunId } : {}),
	};
}

function logOrderStarted(runId: string, orderContext: OrderContext): void {
	try {
		createSkillStatsLog().logOrderStarted({
			orderId: orderContext.orderId,
			runId,
			callerName: orderContext.callerName,
			originAgent: orderContext.originAgent,
			isQueuedOrder: orderContext.isQueuedOrder,
			...(orderContext.originSessionId
				? { originSessionId: orderContext.originSessionId }
				: {}),
			...(orderContext.queuedAtEpochMs
				? { queuedAtEpochMs: orderContext.queuedAtEpochMs }
				: {}),
			...(orderContext.triggeredByRunId
				? { triggeredByRunId: orderContext.triggeredByRunId }
				: {}),
		});
	} catch {
		// Telemetry should not block the orchestrator from starting.
	}
}

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
			runId = createRunId();
			process.argv.push("--run-id", runId);
		}

		const orderContext = buildOrderContext();
		const lockResult = checkAndAcquireLock(runId, orderContext);
		if (lockResult.kind === "QUEUED") {
			process.stdout.write(
				`Order registered: ${lockResult.order.orderId}\n` +
					`A git-commits-push session is already in progress (managed by: ${lockResult.blockedByCallerName}, run: ${lockResult.blockedByRunId}).\n` +
					`Queue position: ${lockResult.position}. This terminal will exit now; the parent session will execute this order asynchronously.\n`,
			);
			process.exit(0);
		}

		logOrderStarted(runId, orderContext);
		startHeartbeat();
		setupCleanupHooks(runId);
	} else {
		if (runId) {
			startHeartbeat();
			setupCleanupHooks(runId);
		}
	}
}
