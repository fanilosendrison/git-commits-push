import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	listQueuedOrders,
	writeLock,
} from "../../src/modules/orders/order-store.ts";
import { releaseLockAndTriggerNext } from "../../src/utils/lock-manager.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dirname,
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
		const result = spawnSync(process.execPath, [SKILL_ENTRYPOINT], {
			env: {
				...process.env,
				...env.env(),
				PI_AGENT: "1",
				PI_SESSION_ID: "session-2",
			},
			encoding: "utf-8",
		});

		assert.strictEqual(result.status, 0);
		assert.ok(result.stdout.includes("Order registered:"));
		assert.ok(result.stdout.includes("run-session-1"));
		assert.ok(result.stdout.includes("Queue position: 1"));

		const queuedOrders = listQueuedOrders(path.join(env.runDir, "orders"));
		assert.strictEqual(queuedOrders.length, 1);
		const queuedOrder = queuedOrders[0]?.order;
		assert.ok(queuedOrder);
		assert.match(queuedOrder.requestedRunId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
		assert.strictEqual(queuedOrder?.originSessionId, "session-2");
		assert.strictEqual(queuedOrder?.blockedByRunId, "run-session-1");
		assert.strictEqual(queuedOrder?.queuePosition, 1);

		const queuedEvent = readEvents().find(
			(event) => event.eventType === "order_queued",
		);
		assert.strictEqual(queuedEvent?.details.orderId, queuedOrder?.orderId);
		assert.strictEqual(queuedEvent?.details.originSessionId, "session-2");
		assert.strictEqual(queuedEvent?.details.blockedByRunId, "run-session-1");

		process.env.ORDER_STATE_DIR = path.join(env.runDir, "orders");
		process.env.PI_SKILL_STATS_DIR = env.statsDir;
		process.env.SECRET_SCANNER_STATS_DIR = env.statsDir;
		process.env.DISABLE_REAL_SPAWN = "1";
		process.env.PI_SESSION_ID = "session-1";

		const releaseResult = releaseLockAndTriggerNext("run-session-1");
		assert.strictEqual(releaseResult.kind, "released");
		if (releaseResult.kind !== "released") return;

		assert.strictEqual(
			releaseResult.triggeredOrder?.orderId,
			queuedOrder?.orderId,
		);
		assert.strictEqual(
			releaseResult.triggeredOrder?.originSessionId,
			"session-2",
		);
		assert.strictEqual(
			releaseResult.triggeredOrder?.triggeredByRunId,
			"run-session-1",
		);
		assert.strictEqual(releaseResult.remainingQueuedOrders, 0);

		const dequeuedEvent = readEvents().find(
			(event) => event.eventType === "order_dequeued",
		);
		assert.strictEqual(dequeuedEvent?.details.orderId, queuedOrder?.orderId);
		assert.strictEqual(
			dequeuedEvent?.details.triggeredByRunId,
			"run-session-1",
		);
	});
});
