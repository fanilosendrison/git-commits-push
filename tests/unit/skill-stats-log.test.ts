import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSkillStatsLog } from "../../src/modules/telemetry/stats-logger.ts";

describe("skill-stats-log Core Unit Tests", () => {
	let statsDir: string;
	let gitStatsDir: string;
	let log: ReturnType<typeof createSkillStatsLog>;

	beforeEach(() => {
		statsDir = path.join(os.tmpdir(), `skill-stats-log-test-${Date.now()}`);
		gitStatsDir = path.join(statsDir, "git-commits-push");
		process.env.SECRET_SCANNER_STATS_DIR = statsDir;
		process.env.PI_SKILL_STATS_DIR = gitStatsDir;
		process.env.PI_SESSION_ID = "stats-test-session";
		delete process.env.PI_SKILL_STATS_MODE;
		log = createSkillStatsLog();
	});

	afterEach(() => {
		delete process.env.SECRET_SCANNER_STATS_DIR;
		delete process.env.PI_SKILL_STATS_DIR;
		delete process.env.PI_SESSION_ID;
		delete process.env.GCP_ORDER_ID;
		delete process.env.GCP_ORDER_ORIGIN_SESSION_ID;
		delete process.env.GCP_ORDER_ORIGIN_AGENT;
		delete process.env.GCP_ORDER_CALLER_NAME;
		delete process.env.GCP_ORDER_QUEUED_AT_EPOCH_MS;
		delete process.env.GCP_ORDER_TRIGGERED_BY_RUN_ID;
		delete process.env.GCP_ORDER_IS_QUEUED;
		if (fs.existsSync(statsDir)) {
			fs.rmSync(statsDir, { recursive: true, force: true });
		}
	});

	function readLatestEvent(logDir: string): {
		eventType: string;
		namespace: string;
		details: Record<string, unknown>;
	} {
		const logFile = path.join(logDir, "events.jsonl");
		const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
		return JSON.parse(lines[lines.length - 1] ?? "");
	}

	test("logSecretPass writes passed event", () => {
		log.logSecretPass({ repoId: "test-repo", repoPath: "/workspace/repo" });
		const event = readLatestEvent(statsDir);
		expect(event.eventType).toBe("passed");
		expect(event.namespace).toBe("secret-scanner");
	});

	test("logSecretBlock writes block event with structured findings", () => {
		log.logSecretBlock({
			repoId: "test-repo",
			repoPath: "/workspace/repo",
			matchCount: 1,
			details: "AWS Key at line 42",
		});
		const event = readLatestEvent(statsDir);
		expect(event.eventType).toBe("block");
		expect(event.namespace).toBe("secret-scanner");
		expect(event.details.findingsCount).toBe(1);
		const findings = event.details.findings as Array<{
			name: string;
			lineNumber: number;
		}>;
		expect(findings[0]?.name).toBe("AWS Key");
		expect(findings[0]?.lineNumber).toBe(42);
	});

	test("logSecretWarning writes warning event with structured findings", () => {
		log.logSecretWarning({
			repoId: "test-repo",
			repoPath: "/workspace/repo",
			matchCount: 1,
			details: "Generic API Key at line 12",
		});
		const event = readLatestEvent(statsDir);
		expect(event.eventType).toBe("warning");
		expect(event.namespace).toBe("secret-scanner");
		expect(event.details.findingsCount).toBe(1);
		const findings = event.details.findings as Array<{
			name: string;
			lineNumber: number;
		}>;
		expect(findings[0]?.name).toBe("Generic API Key");
		expect(findings[0]?.lineNumber).toBe(12);
	});

	test("git-commits-push events include order context from environment", () => {
		process.env.GCP_ORDER_ID = "order-session-2";
		process.env.GCP_ORDER_ORIGIN_SESSION_ID = "session-2";
		process.env.GCP_ORDER_ORIGIN_AGENT = "pi";
		process.env.GCP_ORDER_CALLER_NAME = "Pi Agent";
		process.env.GCP_ORDER_QUEUED_AT_EPOCH_MS = "123";
		process.env.GCP_ORDER_TRIGGERED_BY_RUN_ID = "run-session-1";
		process.env.GCP_ORDER_IS_QUEUED = "1";

		log.logRunStart({
			runId: "run-session-2-execution",
			parentModel: "deepseek-v4-pro",
			skillModel: "deepseek-v4-flash",
			skillProvider: "deepseek",
			reposCount: 1,
			thinking: false,
		});

		const event = readLatestEvent(gitStatsDir);
		expect(event.eventType).toBe("run_start");
		expect(event.namespace).toBe("git-commits-push");
		expect(event.details.orderId).toBe("order-session-2");
		expect(event.details.orderOriginSessionId).toBe("session-2");
		expect(event.details.orderTriggeredByRunId).toBe("run-session-1");
		expect(event.details.isQueuedOrder).toBe(true);
		expect(event.details.executorSessionId).toBe("stats-test-session");
	});

	test("logs order lifecycle events with explicit queue metadata", () => {
		log.logOrderQueued({
			orderId: "order-session-2",
			requestedRunId: "run-session-2-requested",
			originAgent: "pi",
			callerName: "Pi Agent",
			originSessionId: "session-2",
			queuedAtEpochMs: 123,
			position: 1,
			blockedByRunId: "run-session-1",
			blockedByCallerName: "Pi Agent",
		});

		let event = readLatestEvent(gitStatsDir);
		expect(event.eventType).toBe("order_queued");
		expect(event.details.orderId).toBe("order-session-2");
		expect(event.details.requestedRunId).toBe("run-session-2-requested");
		expect(event.details.originSessionId).toBe("session-2");
		expect(event.details.blockedByRunId).toBe("run-session-1");

		log.logOrderFinished({
			runId: "run-session-2-execution",
			outcome: "success",
			successCount: 1,
			failCount: 0,
			totalRepos: 1,
			totalRetries: 0,
		});

		event = readLatestEvent(gitStatsDir);
		expect(event.eventType).toBe("order_finished");
		expect(event.details.runId).toBe("run-session-2-execution");
		expect(event.details.outcome).toBe("success");
	});
});
