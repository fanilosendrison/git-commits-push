import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { OrderContext } from "../../src/modules/orders/types.ts";
import {
	checkAndAcquireLock,
	releaseLockAndTriggerNext,
	startHeartbeat,
	stopHeartbeat,
} from "../../src/utils/lock-manager.ts";

describe("Order Queue and Heartbeat Unit Tests", () => {
	let testStateDir: string;

	beforeEach(() => {
		testStateDir = path.join(
			os.tmpdir(),
			`turnlock-order-test-${Math.random().toString(36).substring(2)}`,
		);
		fs.mkdirSync(testStateDir, { recursive: true });
		process.env.ORDER_STATE_DIR = testStateDir;
		process.env.DISABLE_REAL_SPAWN = "1";
	});

	afterEach(() => {
		stopHeartbeat();
		delete process.env.ORDER_STATE_DIR;
		delete process.env.DISABLE_REAL_SPAWN;
		if (fs.existsSync(testStateDir)) {
			fs.rmSync(testStateDir, { recursive: true, force: true });
		}
	});

	function orderContext(overrides: Partial<OrderContext> = {}): OrderContext {
		return {
			orderId: "order-test",
			originAgent: "pi",
			callerName: "Pi Agent",
			isQueuedOrder: false,
			...overrides,
		};
	}

	test("checkAndAcquireLock acquires lock if empty", () => {
		const result = checkAndAcquireLock(
			"run-1",
			orderContext({ orderId: "order-1", callerName: "TestAgent" }),
		);
		assert.strictEqual(result.kind, "ACQUIRED");

		const lockPath = path.join(testStateDir, "running.lock");
		assert.strictEqual(fs.existsSync(lockPath), true);

		const lockContent = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
		assert.strictEqual(lockContent.runId, "run-1");
		assert.strictEqual(lockContent.callerName, "TestAgent");
		assert.strictEqual(lockContent.orderId, "order-1");
	});

	test("checkAndAcquireLock queues if lock exists and is fresh", () => {
		// Acquire first
		checkAndAcquireLock(
			"run-1",
			orderContext({ orderId: "order-1", callerName: "AgentA" }),
		);

		// Try to acquire from run-2
		const result = checkAndAcquireLock(
			"run-2",
			orderContext({
				orderId: "order-2",
				callerName: "AgentB",
				originSessionId: "session-2",
			}),
		);
		assert.strictEqual(result.kind, "QUEUED");
		if (result.kind !== "QUEUED") return;
		assert.strictEqual(result.position, 1);
		assert.strictEqual(result.blockedByRunId, "run-1");

		// Check that durable order JSON is created
		const files = fs.readdirSync(testStateDir);
		const orderFiles = files.filter(
			(f) => f.startsWith("order-") && f.endsWith(".json"),
		);
		assert.strictEqual(orderFiles.length, 1);
		const queued = JSON.parse(
			fs.readFileSync(path.join(testStateDir, orderFiles[0] ?? ""), "utf-8"),
		);
		assert.strictEqual(queued.orderId, "order-2");
		assert.strictEqual(queued.requestedRunId, "run-2");
		assert.strictEqual(queued.originSessionId, "session-2");
		assert.strictEqual(queued.blockedByRunId, "run-1");
		assert.strictEqual(queued.queuePosition, 1);
	});

	test("checkAndAcquireLock resumes if same runId", () => {
		checkAndAcquireLock(
			"run-1",
			orderContext({ orderId: "order-1", callerName: "AgentA" }),
		);
		const result = checkAndAcquireLock(
			"run-1",
			orderContext({ orderId: "order-1", callerName: "AgentA" }),
		);
		assert.strictEqual(result.kind, "ACQUIRED");
	});

	test("checkAndAcquireLock overwrites lock if stale (> 40 seconds)", () => {
		const lockPath = path.join(testStateDir, "running.lock");

		// Create a stale lock manually
		const now = Date.now();
		const staleTime = now - 50000; // 50 seconds ago
		fs.writeFileSync(
			lockPath,
			JSON.stringify({
				runId: "run-stale",
				callerName: "AgentStale",
				timestamp: staleTime,
			}),
			"utf-8",
		);
		fs.utimesSync(lockPath, new Date(staleTime), new Date(staleTime));

		// Create a stale order flag
		const flagPath = path.join(testStateDir, `order-${staleTime}-abc.flag`);
		fs.writeFileSync(flagPath, "", "utf-8");
		const jsonPath = path.join(testStateDir, `order-${staleTime}-abc.json`);
		fs.writeFileSync(
			jsonPath,
			JSON.stringify({
				orderId: "abc",
				requestedRunId: "run-old",
				originAgent: "pi",
				callerName: "Pi Agent",
				queuedAtEpochMs: staleTime,
			}),
			"utf-8",
		);

		// Acquire
		const result = checkAndAcquireLock(
			"run-new",
			orderContext({ orderId: "order-new", callerName: "AgentNew" }),
		);
		assert.strictEqual(result.kind, "ACQUIRED");

		// Check that stale lock was overwritten and stale flag deleted
		const lockContent = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
		assert.strictEqual(lockContent.runId, "run-new");
		assert.strictEqual(fs.existsSync(flagPath), false);
		assert.strictEqual(fs.existsSync(jsonPath), false);
	});

	test("heartbeat updates running.lock mtime", async () => {
		checkAndAcquireLock(
			"run-1",
			orderContext({ orderId: "order-1", callerName: "AgentA" }),
		);
		const lockPath = path.join(testStateDir, "running.lock");
		// Some supported filesystems expose one-second mtime precision. Move the
		// baseline into the past so a 10ms heartbeat is still observable.
		const baseline = new Date(Date.now() - 2_000);
		fs.utimesSync(lockPath, baseline, baseline);
		const initialMtime = fs.statSync(lockPath).mtimeMs;

		// Start heartbeat with custom 10ms interval
		startHeartbeat(10);

		// Wait 25ms
		await new Promise((resolve) => setTimeout(resolve, 25));

		const newMtime = fs.statSync(lockPath).mtimeMs;
		assert.ok(newMtime > initialMtime);
		stopHeartbeat();
	});

	test("releaseLockAndTriggerNext deletes lock and triggers next if queue exists", () => {
		checkAndAcquireLock(
			"run-1",
			orderContext({ orderId: "order-1", callerName: "AgentA" }),
		);
		checkAndAcquireLock(
			"run-2",
			orderContext({
				orderId: "order-2",
				callerName: "AgentB",
				originSessionId: "session-2",
				queuedAtEpochMs: 100,
			}),
		);
		checkAndAcquireLock(
			"run-3",
			orderContext({
				orderId: "order-3",
				callerName: "AgentC",
				originSessionId: "session-3",
				queuedAtEpochMs: 200,
			}),
		);

		const result = releaseLockAndTriggerNext("run-1");

		// Lock should be deleted
		const lockPath = path.join(testStateDir, "running.lock");
		assert.strictEqual(fs.existsSync(lockPath), false);

		assert.strictEqual(result.kind, "released");
		if (result.kind !== "released") return;
		assert.strictEqual(result.triggeredOrder?.orderId, "order-2");
		assert.strictEqual(result.triggeredOrder?.originSessionId, "session-2");
		assert.strictEqual(result.triggeredOrder?.triggeredByRunId, "run-1");
		assert.strictEqual(result.remainingQueuedOrders, 1);

		const remainingOrderFiles = fs
			.readdirSync(testStateDir)
			.filter((file) => file.startsWith("order-") && file.endsWith(".json"));
		assert.strictEqual(remainingOrderFiles.length, 1);
		const remaining = JSON.parse(
			fs.readFileSync(
				path.join(testStateDir, remainingOrderFiles[0] ?? ""),
				"utf-8",
			),
		);
		assert.strictEqual(remaining.orderId, "order-3");
	});
});
