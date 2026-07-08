import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
		expect(result.kind).toBe("ACQUIRED");

		const lockPath = path.join(testStateDir, "running.lock");
		expect(fs.existsSync(lockPath)).toBe(true);

		const lockContent = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
		expect(lockContent.runId).toBe("run-1");
		expect(lockContent.callerName).toBe("TestAgent");
		expect(lockContent.orderId).toBe("order-1");
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
		expect(result.kind).toBe("QUEUED");
		if (result.kind !== "QUEUED") return;
		expect(result.position).toBe(1);
		expect(result.blockedByRunId).toBe("run-1");

		// Check that durable order JSON is created
		const files = fs.readdirSync(testStateDir);
		const orderFiles = files.filter(
			(f) => f.startsWith("order-") && f.endsWith(".json"),
		);
		expect(orderFiles.length).toBe(1);
		const queued = JSON.parse(
			fs.readFileSync(path.join(testStateDir, orderFiles[0] ?? ""), "utf-8"),
		);
		expect(queued.orderId).toBe("order-2");
		expect(queued.requestedRunId).toBe("run-2");
		expect(queued.originSessionId).toBe("session-2");
		expect(queued.blockedByRunId).toBe("run-1");
		expect(queued.queuePosition).toBe(1);
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
		expect(result.kind).toBe("ACQUIRED");
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
		expect(result.kind).toBe("ACQUIRED");

		// Check that stale lock was overwritten and stale flag deleted
		const lockContent = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
		expect(lockContent.runId).toBe("run-new");
		expect(fs.existsSync(flagPath)).toBe(false);
		expect(fs.existsSync(jsonPath)).toBe(false);
	});

	test("heartbeat updates running.lock mtime", async () => {
		checkAndAcquireLock(
			"run-1",
			orderContext({ orderId: "order-1", callerName: "AgentA" }),
		);
		const lockPath = path.join(testStateDir, "running.lock");
		const initialMtime = fs.statSync(lockPath).mtimeMs;

		// Start heartbeat with custom 10ms interval
		startHeartbeat(10);

		// Wait 25ms
		await new Promise((resolve) => setTimeout(resolve, 25));

		const newMtime = fs.statSync(lockPath).mtimeMs;
		expect(newMtime).toBeGreaterThan(initialMtime);
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
		expect(fs.existsSync(lockPath)).toBe(false);

		expect(result.kind).toBe("released");
		if (result.kind !== "released") return;
		expect(result.triggeredOrder?.orderId).toBe("order-2");
		expect(result.triggeredOrder?.originSessionId).toBe("session-2");
		expect(result.triggeredOrder?.triggeredByRunId).toBe("run-1");
		expect(result.remainingQueuedOrders).toBe(1);

		const remainingOrderFiles = fs
			.readdirSync(testStateDir)
			.filter((file) => file.startsWith("order-") && file.endsWith(".json"));
		expect(remainingOrderFiles.length).toBe(1);
		const remaining = JSON.parse(
			fs.readFileSync(
				path.join(testStateDir, remainingOrderFiles[0] ?? ""),
				"utf-8",
			),
		);
		expect(remaining.orderId).toBe("order-3");
	});
});
