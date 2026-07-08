import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkAndAcquireLock, releaseLockAndTriggerNext, startHeartbeat, stopHeartbeat } from "../../src/utils/order.ts";



describe("Order Queue and Heartbeat Unit Tests", () => {
	let testStateDir: string;

	beforeEach(() => {
		testStateDir = path.join(os.tmpdir(), "turnlock-order-test-" + Math.random().toString(36).substring(2));
		fs.mkdirSync(testStateDir, { recursive: true });
		process.env.ORDER_STATE_DIR = testStateDir;
		process.env.DISABLE_REAL_SPAWN = "1";
	});

	afterEach(() => {
		stopHeartbeat();
		delete process.env.ORDER_STATE_DIR;
		if (fs.existsSync(testStateDir)) {
			fs.rmSync(testStateDir, { recursive: true, force: true });
		}
	});

	test("checkAndAcquireLock acquires lock if empty", () => {
		const result = checkAndAcquireLock("run-1", "TestAgent");
		expect(result).toBe("ACQUIRED");

		const lockPath = path.join(testStateDir, "running.lock");
		expect(fs.existsSync(lockPath)).toBe(true);

		const lockContent = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
		expect(lockContent.runId).toBe("run-1");
		expect(lockContent.callerName).toBe("TestAgent");
	});

	test("checkAndAcquireLock queues if lock exists and is fresh", () => {
		// Acquire first
		checkAndAcquireLock("run-1", "AgentA");

		// Try to acquire from run-2
		const result = checkAndAcquireLock("run-2", "AgentB");
		expect(result).toBe("QUEUED");

		// Check that order flag is created
		const files = fs.readdirSync(testStateDir);
		const flags = files.filter(f => f.startsWith("order-"));
		expect(flags.length).toBe(1);
	});

	test("checkAndAcquireLock resumes if same runId", () => {
		checkAndAcquireLock("run-1", "AgentA");
		const result = checkAndAcquireLock("run-1", "AgentA");
		expect(result).toBe("ACQUIRED");
	});

	test("checkAndAcquireLock overwrites lock if stale (> 40 seconds)", () => {
		const lockPath = path.join(testStateDir, "running.lock");
		
		// Create a stale lock manually
		const now = Date.now();
		const staleTime = now - 50000; // 50 seconds ago
		fs.writeFileSync(lockPath, JSON.stringify({
			runId: "run-stale",
			callerName: "AgentStale",
			timestamp: staleTime
		}), "utf-8");
		fs.utimesSync(lockPath, new Date(staleTime), new Date(staleTime));

		// Create a stale order flag
		const flagPath = path.join(testStateDir, `order-${staleTime}-abc.flag`);
		fs.writeFileSync(flagPath, "", "utf-8");

		// Acquire
		const result = checkAndAcquireLock("run-new", "AgentNew");
		expect(result).toBe("ACQUIRED");

		// Check that stale lock was overwritten and stale flag deleted
		const lockContent = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
		expect(lockContent.runId).toBe("run-new");
		expect(fs.existsSync(flagPath)).toBe(false);
	});

	test("heartbeat updates running.lock mtime", async () => {
		checkAndAcquireLock("run-1", "AgentA");
		const lockPath = path.join(testStateDir, "running.lock");
		const initialMtime = fs.statSync(lockPath).mtimeMs;

		// Start heartbeat with custom 10ms interval
		startHeartbeat(10);

		// Wait 25ms
		await new Promise(resolve => setTimeout(resolve, 25));

		const newMtime = fs.statSync(lockPath).mtimeMs;
		expect(newMtime).toBeGreaterThan(initialMtime);
		stopHeartbeat();
	});

	test("releaseLockAndTriggerNext deletes lock and triggers next if queue exists", () => {
		checkAndAcquireLock("run-1", "AgentA");
		
		// Create flags
		const time = Date.now();
		const flag1 = path.join(testStateDir, `order-${time}-1.flag`);
		const flag2 = path.join(testStateDir, `order-${time + 10}-2.flag`);
		fs.writeFileSync(flag1, "", "utf-8");
		fs.writeFileSync(flag2, "", "utf-8");

		releaseLockAndTriggerNext("run-1");

		// Lock should be deleted
		const lockPath = path.join(testStateDir, "running.lock");
		expect(fs.existsSync(lockPath)).toBe(false);

		// Oldest flag should be deleted (flag1)
		expect(fs.existsSync(flag1)).toBe(false);
		expect(fs.existsSync(flag2)).toBe(true);

	});
});
