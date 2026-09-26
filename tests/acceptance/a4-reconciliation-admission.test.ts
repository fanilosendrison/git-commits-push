import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dirname,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

describe("A4 — Orchestrator is free of global scheduling", () => {
	let env: MockTurnlockEnvironment;
	let cleanRepository: GitRepoFixture;

	beforeEach(() => {
		env = MockTurnlockEnvironment.create();
		cleanRepository = GitRepoFixture.create();
		cleanRepository.commit("initial commit");
		env.writeSettings({
			searchPaths: [cleanRepository.dir],
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			temperature: 0,
			systemPromptPath: path.join(
				import.meta.dirname,
				"../../system-prompt.md",
			),
			autoPush: false,
			skipTests: true,
		});
	});

	afterEach(() => {
		delete process.env.ORDER_STATE_DIR;
		delete process.env.PI_SKILL_STATS_DIR;
		delete process.env.SECRET_SCANNER_STATS_DIR;
		delete process.env.PI_SESSION_ID;
		env.dispose();
		cleanRepository.dispose();
	});

	test("A4-01 | a direct orchestrator run creates no queue artifacts", () => {
		const orderStateDir = path.join(env.runDir, "orders");
		const result = spawnSync(process.execPath, [SKILL_ENTRYPOINT], {
			env: {
				...process.env,
				...env.env(),
				PI_AGENT: "1",
				PI_SESSION_ID: "session-a4",
				GCP_INVOCATION_CWD: cleanRepository.dir,
			},
			encoding: "utf-8",
		});

		assert.strictEqual(result.status, 0);
		// The phases only report their Turnlock result; global coordination
		// belongs to the top-level launcher.
		const files = fs.existsSync(orderStateDir)
			? fs.readdirSync(orderStateDir)
			: [];
		assert.deepStrictEqual(files, []);
	});

	test("A4-02 | orchestrator stdout carries no queue messages", () => {
		const result = spawnSync(process.execPath, [SKILL_ENTRYPOINT], {
			env: {
				...process.env,
				...env.env(),
				PI_AGENT: "1",
				PI_SESSION_ID: "session-a4",
				GCP_INVOCATION_CWD: cleanRepository.dir,
			},
			encoding: "utf-8",
		});

		assert.strictEqual(result.status, 0);
		assert.ok(!result.stdout.includes("Queue position"));
		assert.ok(!result.stdout.includes("Order registered"));
		assert.ok(!result.stdout.includes("order_queued"));
	});
});
