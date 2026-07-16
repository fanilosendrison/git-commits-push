import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	createSkillStatsLog,
	getActiveSessionId,
	getAgentName,
} from "../../src/modules/telemetry/stats-logger.ts";

describe("skill-stats-log Core Unit Tests", () => {
	let statsDir: string;
	let gitStatsDir: string;
	let log: ReturnType<typeof createSkillStatsLog>;

	let originalAntigravityAgent: string | undefined;
	let originalAntigravityTrajectoryId: string | undefined;
	let originalCodexThreadId: string | undefined;

	beforeEach(() => {
		originalAntigravityAgent = process.env.ANTIGRAVITY_AGENT;
		originalAntigravityTrajectoryId = process.env.ANTIGRAVITY_TRAJECTORY_ID;
		originalCodexThreadId = process.env.CODEX_THREAD_ID;
		delete process.env.ANTIGRAVITY_AGENT;
		delete process.env.ANTIGRAVITY_TRAJECTORY_ID;
		delete process.env.CODEX_THREAD_ID;

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
		if (originalAntigravityAgent !== undefined) {
			process.env.ANTIGRAVITY_AGENT = originalAntigravityAgent;
		}
		if (originalAntigravityTrajectoryId !== undefined) {
			process.env.ANTIGRAVITY_TRAJECTORY_ID = originalAntigravityTrajectoryId;
		}
		if (originalCodexThreadId !== undefined) {
			process.env.CODEX_THREAD_ID = originalCodexThreadId;
		}
		if (fs.existsSync(statsDir)) {
			fs.rmSync(statsDir, { recursive: true, force: true });
		}
	});

	function readLatestEvent(logDir: string): {
		agent: string;
		eventType: string;
		namespace: string;
		sessionId?: string;
		details: Record<string, unknown>;
	} {
		const logFile = path.join(logDir, "events.jsonl");
		// The event sink writes asynchronously — poll briefly until the file
		// appears to avoid a race on slow CI / local runs.
		const deadline = Date.now() + 2000;
		while (!fs.existsSync(logFile) && Date.now() < deadline) {
			// yield the event loop so the pending async write can land
			Bun.sleepSync(5);
		}
		if (!fs.existsSync(logFile)) {
			throw new Error(`Expected events.jsonl to exist at ${logFile} within 2s`);
		}
		const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
		return JSON.parse(lines[lines.length - 1] ?? "");
	}

	test("detects Codex agent and session from CODEX_THREAD_ID", () => {
		delete process.env.PI_SESSION_ID;
		process.env.CODEX_THREAD_ID = "codex-thread-123";

		expect(getAgentName()).toBe("codex");
		expect(getActiveSessionId()).toBe("codex-thread-123");
	});

	test("keeps Antigravity and Pi telemetry detection intact", () => {
		process.env.ANTIGRAVITY_AGENT = "1";
		process.env.ANTIGRAVITY_TRAJECTORY_ID = "ag-trajectory-123";
		expect(getAgentName()).toBe("antigravity");
		expect(getActiveSessionId()).toBe("ag-trajectory-123");

		delete process.env.ANTIGRAVITY_AGENT;
		delete process.env.ANTIGRAVITY_TRAJECTORY_ID;
		process.env.PI_SESSION_ID = "pi-session-123";
		process.env.CODEX_THREAD_ID = "codex-thread-ignored";
		expect(getAgentName()).toBe("pi");
		expect(getActiveSessionId()).toBe("pi-session-123");
	});

	test("throws outside known agent environments", () => {
		const statsLoggerUrl = pathToFileURL(
			path.join(import.meta.dir, "../../src/modules/telemetry/stats-logger.ts"),
		).href;
		const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
		delete env.ANTIGRAVITY_AGENT;
		delete env.ANTIGRAVITY_TRAJECTORY_ID;
		delete env.PI_SESSION_ID;
		delete env.CODEX_THREAD_ID;
		delete env.PI_SKILL_STATS_MODE;

		const result = spawnSync(
			"bun",
			[
				"-e",
				"const mod = await import(process.argv[1]); try { mod.getAgentName(); process.exit(0); } catch (err) { process.stderr.write(err instanceof Error ? err.message : String(err)); process.exit(7); }",
				statsLoggerUrl,
			],
			{ env, encoding: "utf-8" },
		);

		expect(result.status).toBe(7);
		expect(result.stderr).toContain("Missing required environment variables");
	});

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

	test("writes git-commits-push events as codex with CODEX_THREAD_ID", () => {
		delete process.env.PI_SESSION_ID;
		process.env.CODEX_THREAD_ID = "codex-thread-events";
		const codexLog = createSkillStatsLog();

		codexLog.logRunStart({
			runId: "run-codex",
			parentModel: "gpt-5.5",
			skillModel: "deepseek-v4-flash",
			skillProvider: "deepseek",
			reposCount: 1,
			thinking: false,
		});

		const event = readLatestEvent(gitStatsDir);
		expect(event.agent).toBe("codex");
		expect(event.eventType).toBe("run_start");
		expect(event.namespace).toBe("git-commits-push");
		expect(event.sessionId).toBe("codex-thread-events");
		expect(event.details.executorSessionId).toBe("codex-thread-events");
		expect(event.details.parentModel).toBe("gpt-5.5");
	});

	test("subprocess writes git-commits-push events as codex in production env", () => {
		const statsLoggerUrl = pathToFileURL(
			path.join(import.meta.dir, "../../src/modules/telemetry/stats-logger.ts"),
		).href;
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CODEX_THREAD_ID: "codex-thread-subprocess",
			NODE_ENV: "production",
			PI_SKILL_STATS_DIR: gitStatsDir,
			SECRET_SCANNER_STATS_DIR: path.join(statsDir, "secret-scanner"),
		};
		delete env.ANTIGRAVITY_AGENT;
		delete env.ANTIGRAVITY_TRAJECTORY_ID;
		delete env.PI_SESSION_ID;
		delete env.PI_SKILL_STATS_MODE;

		const result = spawnSync(
			"bun",
			[
				"-e",
				"const mod = await import(process.argv[1]); const log = mod.createSkillStatsLog(); log.logRunStart({ runId: 'run-codex-subprocess', parentModel: 'gpt-5.5', skillModel: 'deepseek-v4-flash', skillProvider: 'deepseek', reposCount: 1, thinking: false });",
				statsLoggerUrl,
			],
			{ env, encoding: "utf-8" },
		);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		const event = readLatestEvent(gitStatsDir);
		expect(event.agent).toBe("codex");
		expect(event.sessionId).toBe("codex-thread-subprocess");
		expect(event.details.executorSessionId).toBe("codex-thread-subprocess");
		expect(event.details.runId).toBe("run-codex-subprocess");
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
