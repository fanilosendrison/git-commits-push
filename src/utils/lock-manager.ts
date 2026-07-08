import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	deleteQueuedOrder,
	deleteQueuedOrderFiles,
	listQueuedOrders,
	readLock,
	writeLock,
	writeQueuedOrder,
} from "../modules/orders/order-store.ts";
import {
	type AcquireLockResult,
	type LockMetadata,
	ORDER_ENV_KEYS,
	type OrderContext,
	type OrderMetadata,
	type ReleaseLockResult,
} from "../modules/orders/types.ts";
import { createSkillStatsLog } from "../modules/telemetry/stats-logger.ts";

function resolveHome(filepath: string): string {
	if (filepath.startsWith("~")) {
		return path.join(os.homedir(), filepath.slice(1));
	}
	return filepath;
}

function getStateDir(): string {
	if (process.env.ORDER_STATE_DIR) {
		return resolveHome(process.env.ORDER_STATE_DIR);
	}
	return path.join(import.meta.dir, "../../.state/orders");
}

function buildLock(runId: string, context: OrderContext): LockMetadata {
	const timestamp = Date.now();
	return {
		runId,
		callerName: context.callerName,
		timestamp,
		orderId: context.orderId,
		originAgent: context.originAgent,
		...(context.originSessionId
			? { originSessionId: context.originSessionId }
			: {}),
	};
}

function buildOrder(
	runId: string,
	context: OrderContext,
	queuedAtEpochMs: number,
	blockedBy?: LockMetadata,
): OrderMetadata {
	return {
		orderId: context.orderId,
		requestedRunId: runId,
		originAgent: context.originAgent,
		callerName: context.callerName,
		queuedAtEpochMs,
		...(context.originSessionId
			? { originSessionId: context.originSessionId }
			: {}),
		...(context.triggeredByRunId
			? { triggeredByRunId: context.triggeredByRunId }
			: {}),
		...(blockedBy
			? {
					blockedByRunId: blockedBy.runId,
					blockedByCallerName: blockedBy.callerName,
				}
			: {}),
	};
}

function logOrderQueueEvent(
	event:
		| {
				type: "queued";
				order: OrderMetadata;
				position: number;
				blockedByRunId: string;
				blockedByCallerName: string;
		  }
		| {
				type: "dequeued";
				order: OrderMetadata;
				triggeredByRunId: string;
				remainingQueuedOrders: number;
		  }
		| {
				type: "queue_empty";
				runId: string;
		  },
): void {
	try {
		const log = createSkillStatsLog();
		if (event.type === "queued") {
			log.logOrderQueued({
				orderId: event.order.orderId,
				requestedRunId: event.order.requestedRunId,
				originAgent: event.order.originAgent,
				callerName: event.order.callerName,
				queuedAtEpochMs: event.order.queuedAtEpochMs,
				position: event.position,
				blockedByRunId: event.blockedByRunId,
				blockedByCallerName: event.blockedByCallerName,
				...(event.order.originSessionId
					? { originSessionId: event.order.originSessionId }
					: {}),
			});
			return;
		}

		if (event.type === "dequeued") {
			log.logOrderDequeued({
				orderId: event.order.orderId,
				requestedRunId: event.order.requestedRunId,
				originAgent: event.order.originAgent,
				callerName: event.order.callerName,
				queuedAtEpochMs: event.order.queuedAtEpochMs,
				triggeredByRunId: event.triggeredByRunId,
				remainingQueuedOrders: event.remainingQueuedOrders,
				...(event.order.originSessionId
					? { originSessionId: event.order.originSessionId }
					: {}),
			});
			return;
		}

		log.logQueueEmpty({ runId: event.runId });
	} catch {
		// Telemetry must never prevent lock cleanup.
	}
}

export function checkAndAcquireLock(
	runId: string,
	context: OrderContext,
): AcquireLockResult {
	const dir = getStateDir();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	const lockPath = path.join(dir, "running.lock");

	if (fs.existsSync(lockPath)) {
		const lockContent = readLock(lockPath);
		if (!lockContent) {
			// Malformed lock file -> treat as stale
			const lock = buildLock(runId, context);
			writeLock(lockPath, lock);
			return {
				kind: "ACQUIRED",
				order: buildOrder(
					runId,
					context,
					context.queuedAtEpochMs ?? lock.timestamp,
				),
				lock,
			};
		}

		if (lockContent.runId === runId) {
			return {
				kind: "ACQUIRED",
				order: buildOrder(
					runId,
					context,
					context.queuedAtEpochMs ?? lockContent.timestamp,
				),
				lock: lockContent,
			};
		}

		const stat = fs.statSync(lockPath);
		const ageMs = Date.now() - stat.mtimeMs;

		if (ageMs > 40000) {
			// Stale lock: clean up old lock and any stale queues
			try {
				fs.unlinkSync(lockPath);
				deleteQueuedOrderFiles(dir);
			} catch {
				// ignore race conditions during deletion
			}

			const lock = buildLock(runId, context);
			writeLock(lockPath, lock);
			return {
				kind: "ACQUIRED",
				order: buildOrder(
					runId,
					context,
					context.queuedAtEpochMs ?? lock.timestamp,
				),
				lock,
			};
		}

		// Active lock exists -> queue the order
		const queuedAtEpochMs = context.queuedAtEpochMs ?? Date.now();
		const orderWithoutPosition = buildOrder(
			runId,
			context,
			queuedAtEpochMs,
			lockContent,
		);
		const filePath = writeQueuedOrder(dir, orderWithoutPosition);
		const queuedOrders = listQueuedOrders(dir);
		const position =
			queuedOrders.findIndex((record) => record.filePath === filePath) + 1 ||
			queuedOrders.length;
		const order = { ...orderWithoutPosition, queuePosition: position };
		writeQueuedOrder(dir, order);
		logOrderQueueEvent({
			type: "queued",
			order,
			position,
			blockedByRunId: lockContent.runId,
			blockedByCallerName: lockContent.callerName,
		});

		return {
			kind: "QUEUED",
			order,
			position,
			blockedByRunId: lockContent.runId,
			blockedByCallerName: lockContent.callerName,
		};
	}

	const lock = buildLock(runId, context);
	writeLock(lockPath, lock);
	return {
		kind: "ACQUIRED",
		order: buildOrder(
			runId,
			context,
			context.queuedAtEpochMs ?? lock.timestamp,
		),
		lock,
	};
}

function buildChildEnv(
	order: OrderMetadata,
	triggeredByRunId: string,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		[ORDER_ENV_KEYS.orderId]: order.orderId,
		[ORDER_ENV_KEYS.originAgent]: order.originAgent,
		[ORDER_ENV_KEYS.callerName]: order.callerName,
		[ORDER_ENV_KEYS.queuedAtEpochMs]: String(order.queuedAtEpochMs),
		[ORDER_ENV_KEYS.triggeredByRunId]: triggeredByRunId,
		[ORDER_ENV_KEYS.isQueuedOrder]: "1",
	};

	if (order.originSessionId) {
		env[ORDER_ENV_KEYS.originSessionId] = order.originSessionId;
	}

	return env;
}

export function releaseLockAndTriggerNext(runId: string): ReleaseLockResult {
	const dir = getStateDir();
	const lockPath = path.join(dir, "running.lock");

	if (!fs.existsSync(lockPath)) {
		stopHeartbeat();
		return { kind: "missing-lock" };
	}

	const lockContent = readLock(lockPath);
	if (!lockContent) {
		stopHeartbeat();
		return { kind: "malformed-lock" };
	}

	if (lockContent.runId !== runId) {
		stopHeartbeat();
		return { kind: "not-owner" };
	}

	try {
		fs.unlinkSync(lockPath);
	} catch {
		// ignore
	}

	stopHeartbeat();

	// Trigger next in queue if any
	if (fs.existsSync(dir)) {
		const queuedOrders = listQueuedOrders(dir);
		const next = queuedOrders[0];
		if (!next) {
			logOrderQueueEvent({ type: "queue_empty", runId });
			return { kind: "released", remainingQueuedOrders: 0 };
		}

		try {
			deleteQueuedOrder(next);
		} catch {
			// ignore
		}

		const remainingQueuedOrders = listQueuedOrders(dir).length;
		const triggeredOrder: OrderMetadata = {
			...next.order,
			triggeredByRunId: runId,
		};
		logOrderQueueEvent({
			type: "dequeued",
			order: triggeredOrder,
			triggeredByRunId: runId,
			remainingQueuedOrders,
		});

		if (process.env.DISABLE_REAL_SPAWN === "1") {
			return {
				kind: "released",
				triggeredOrder,
				remainingQueuedOrders,
			};
		}

		// Run next job in the foreground of the current session
		const skillRoot = path.resolve(__dirname, "../..");
		spawnSync("bun", ["run", "start"], {
			cwd: skillRoot,
			env: buildChildEnv(triggeredOrder, runId),
			stdio: "inherit",
		});

		return {
			kind: "released",
			triggeredOrder,
			remainingQueuedOrders,
		};
	}

	return { kind: "released", remainingQueuedOrders: 0 };
}

let heartbeatInterval: Timer | null = null;

export function startHeartbeat(intervalMs = 10000): void {
	if (heartbeatInterval) return;
	const dir = getStateDir();
	const lockPath = path.join(dir, "running.lock");

	heartbeatInterval = setInterval(() => {
		if (fs.existsSync(lockPath)) {
			const now = new Date();
			try {
				fs.utimesSync(lockPath, now, now);
			} catch {
				// ignore
			}
		}
	}, intervalMs);
}

export function stopHeartbeat(): void {
	if (heartbeatInterval) {
		clearInterval(heartbeatInterval);
		heartbeatInterval = null;
	}
}

export function setupCleanupHooks(runId: string): void {
	const cleanup = () => {
		stopHeartbeat();
		const dir = getStateDir();
		const lockPath = path.join(dir, "running.lock");
		try {
			if (fs.existsSync(lockPath)) {
				const lockContent = readLock(lockPath);
				if (lockContent?.runId === runId) {
					fs.unlinkSync(lockPath);
				}
			}
		} catch {
			// ignore
		}
		process.exit(1);
	};

	process.on("SIGINT", cleanup);
	process.on("uncaughtException", (err) => {
		console.error("Uncaught exception in process:", err);
		cleanup();
	});
}
