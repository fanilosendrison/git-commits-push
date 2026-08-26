import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSkillStatsLog } from "../../src/modules/telemetry/stats-logger.ts";

const ENVIRONMENT_KEYS = [
	"ANTIGRAVITY_AGENT",
	"ANTIGRAVITY_TRAJECTORY_ID",
	"CODEX_THREAD_ID",
	"GCP_ORDER_IS_QUEUED",
	"NODE_ENV",
	"PI_SESSION_ID",
	"PI_SKILL_STATS_DIR",
	"PI_SKILL_STATS_MODE",
	"SECRET_SCANNER_STATS_DIR",
] as const;

test("published event-sink preserves git-commits-push telemetry", (context) => {
	const previousEnvironment = new Map(
		ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
	);
	const root = mkdtempSync(join(tmpdir(), "gcp-node-event-sink-"));
	const statsDir = join(root, "git-commits-push");

	context.after(() => {
		for (const [key, value] of previousEnvironment) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	for (const key of ENVIRONMENT_KEYS) delete process.env[key];
	process.env.PI_SESSION_ID = "node-stats-session";
	process.env.PI_SKILL_STATS_DIR = statsDir;

	createSkillStatsLog().logRunStart({
		runId: "node-smoke-run",
		parentModel: "parent-model",
		skillModel: "skill-model",
		skillProvider: "skill-provider",
		reposCount: 2,
		thinking: true,
	});

	const lines = readFileSync(join(statsDir, "events.jsonl"), "utf8")
		.trim()
		.split("\n");
	assert.strictEqual(lines.length, 1);

	const event = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
	assert.match(String(event.timestamp), /^\d{4}-\d{2}-\d{2}T/);
	assert.match(
		String(event.eventId),
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
	);
	assert.strictEqual(event.agent, "pi");
	assert.strictEqual(event.namespace, "git-commits-push");
	assert.strictEqual(event.eventType, "run_start");
	assert.strictEqual(event.workspace, process.cwd());
	assert.strictEqual(event.sessionId, "node-stats-session");

	const details = event.details as Record<string, unknown>;
	const { cycleId, ...stableDetails } = details;
	assert.match(
		String(cycleId),
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
	);
	assert.deepStrictEqual(stableDetails, {
		executorSessionId: "node-stats-session",
		isQueuedOrder: false,
		runId: "node-smoke-run",
		parentModel: "parent-model",
		skillModel: "skill-model",
		skillProvider: "skill-provider",
		reposCount: 2,
		thinking: true,
	});
});
