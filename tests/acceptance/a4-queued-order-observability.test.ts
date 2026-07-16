import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	listQueuedOrders,
	writeLock,
} from "../../src/modules/orders/order-store.ts";
import { releaseLockAndTriggerNext } from "../../src/utils/lock-manager.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dir,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

describe("A4 — Queued order observability", () => {
	let env: MockTurnlockEnvironment;

	beforeEach(() => {
		env = MockTurnlockEnvironment.create();
		fs.mkdirSync(path.join(env.runDir, "orders"), { recursive: true });
		writeLock(path.join(env.runDir, "orders", "running.lock"), {
			runId: "run-session-1",
			callerName: "Pi Agent",
			timestamp: Date.now(),
			orderId: "order-session-1",
			originAgent: "pi",
			originSessionId: "session-1",
		});
	});

	afterEach(() => {
		delete process.env.ORDER_STATE_DIR;
		delete process.env.PI_SKILL_STATS_DIR;
		delete process.env.SECRET_SCANNER_STATS_DIR;
		delete process.env.DISABLE_REAL_SPAWN;
		delete process.env.PI_SESSION_ID;
		env.dispose();
	});

	function readEvents(): Array<{
		eventType: string;
		details: Record<string, unknown>;
	}> {
		const logFile = path.join(env.statsDir, "events.jsonl");
		const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
		return lines.map((line) => JSON.parse(line));
	}

	test("second session registers an order that parent release can identify", () => {
		const result = spawnSync("bun", ["run", SKILL_ENTRYPOINT], {
			env: {
				...process.env,
				...env.env(),
				PI_AGENT: "1",
				PI_SESSION_ID: "session-2",
			},
			encoding: "utf-8",
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Order registered:");
		expect(result.stdout).toContain("run-session-1");
		expect(result.stdout).toContain("Queue position: 1");

		const queuedOrders = listQueuedOrders(path.join(env.runDir, "orders"));
		expect(queuedOrders.length).toBe(1);
		const queuedOrder = queuedOrders[0]?.order;
		expect(queuedOrder?.requestedRunId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(queuedOrder?.originSessionId).toBe("session-2");
		expect(queuedOrder?.blockedByRunId).toBe("run-session-1");
		expect(queuedOrder?.queuePosition).toBe(1);

		const queuedEvent = readEvents().find(
			(event) => event.eventType === "order_queued",
		);
		expect(queuedEvent?.details.orderId).toBe(queuedOrder?.orderId);
		expect(queuedEvent?.details.originSessionId).toBe("session-2");
		expect(queuedEvent?.details.blockedByRunId).toBe("run-session-1");

		process.env.ORDER_STATE_DIR = path.join(env.runDir, "orders");
		process.env.PI_SKILL_STATS_DIR = env.statsDir;
		process.env.SECRET_SCANNER_STATS_DIR = env.statsDir;
		process.env.DISABLE_REAL_SPAWN = "1";
		process.env.PI_SESSION_ID = "session-1";

		const releaseResult = releaseLockAndTriggerNext("run-session-1");
		expect(releaseResult.kind).toBe("released");
		if (releaseResult.kind !== "released") return;

		expect(releaseResult.triggeredOrder?.orderId).toBe(queuedOrder?.orderId);
		expect(releaseResult.triggeredOrder?.originSessionId).toBe("session-2");
		expect(releaseResult.triggeredOrder?.triggeredByRunId).toBe(
			"run-session-1",
		);
		expect(releaseResult.remainingQueuedOrders).toBe(0);

		const dequeuedEvent = readEvents().find(
			(event) => event.eventType === "order_dequeued",
		);
		expect(dequeuedEvent?.details.orderId).toBe(queuedOrder?.orderId);
		expect(dequeuedEvent?.details.triggeredByRunId).toBe("run-session-1");
	});
});
