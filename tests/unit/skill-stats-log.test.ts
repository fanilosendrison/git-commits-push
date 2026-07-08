import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSkillStatsLog } from "../../src/modules/telemetry/stats-logger.ts";

describe("skill-stats-log Core Unit Tests", () => {
	let statsDir: string;
	let log: ReturnType<typeof createSkillStatsLog>;

	beforeAll(() => {
		statsDir = path.join(os.tmpdir(), "skill-stats-log-test-" + Date.now());
		process.env.SECRET_SCANNER_STATS_DIR = statsDir;
		process.env.PI_SKILL_STATS_DIR = path.join(statsDir, "git-commits-push");
		log = createSkillStatsLog();
	});

	afterAll(() => {
		delete process.env.SECRET_SCANNER_STATS_DIR;
		delete process.env.PI_SKILL_STATS_DIR;
		if (fs.existsSync(statsDir)) {
			fs.rmSync(statsDir, { recursive: true, force: true });
		}
	});

	test("logSecretPass writes passed event", () => {
		log.logSecretPass({ repoId: "test-repo", repoPath: "/workspace/repo" });
		const logFile = path.join(statsDir, "events.jsonl");
		expect(fs.existsSync(logFile)).toBe(true);
		const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
		const event = JSON.parse(lines[lines.length - 1] ?? "");
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
		const logFile = path.join(statsDir, "events.jsonl");
		const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
		const event = JSON.parse(lines[lines.length - 1] ?? "");
		expect(event.eventType).toBe("block");
		expect(event.namespace).toBe("secret-scanner");
		expect(event.details.findingsCount).toBe(1);
		expect(event.details.findings[0].name).toBe("AWS Key");
		expect(event.details.findings[0].lineNumber).toBe(42);
	});
});
