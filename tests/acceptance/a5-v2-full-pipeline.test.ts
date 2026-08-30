// A5 — Full Turnlock v2 CLI pipeline
// This test crosses real process boundaries. Only the nondeterministic external
// LLM HTTP call is replaced by a Node preload; Turnlock, the bridge, resume,
// and Git publishing all execute their production implementations.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";

let repoDirty: GitRepoFixture;
let env: MockTurnlockEnvironment;
let searchRoot: string;
let stdout: string;
let stderr: string;
let exitCode: number;
let turnlockRunDir: string;

const SKILL_ROOT = path.resolve(import.meta.dirname, "../..");
const ORCHESTRATOR_ENTRYPOINT = path.resolve(
	import.meta.dirname,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);
const BRIDGE_ENTRYPOINT = path.resolve(
	import.meta.dirname,
	"../../src/entrypoints/turnlock-to-llm-bridge.ts",
);
const MOCK_OPENAI_FETCH_PRELOAD = path.resolve(
	import.meta.dirname,
	"../fixtures/mock-openai-fetch.ts",
);

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

before(() => {
	env = MockTurnlockEnvironment.create();
	searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "a5-v2-pipeline-"));
	repoDirty = GitRepoFixture.create({ parentDir: searchRoot });
	repoDirty.commit("initial commit");
	repoDirty.writeAndStage("pipeline.ts", "export const pipelineVersion = 2;\n");
	env.writeSettings({
		searchPaths: [searchRoot],
		provider: "openai",
		model: "gpt-5.4-mini",
		temperature: 0,
		systemPromptPath: path.join(searchRoot, "missing-system-prompt.md"),
		autoPush: false,
		skipTests: true,
		agent: "git-commits-push",
	});

	// Resolve `node` through PATH so compatibility launchers remain active on
	// older macOS hosts; process.execPath points past those launchers.
	const nodeExecutable = shellQuote("node");
	const preloadArgument = shellQuote(MOCK_OPENAI_FETCH_PRELOAD);
	const pipelineCommand = [
		`${nodeExecutable} --import ${preloadArgument} ${shellQuote(ORCHESTRATOR_ENTRYPOINT)}`,
		`${nodeExecutable} --import ${preloadArgument} ${shellQuote(BRIDGE_ENTRYPOINT)}`,
	].join(" | ");
	const result = spawnSync("sh", ["-c", pipelineCommand], {
		cwd: SKILL_ROOT,
		env: {
			...process.env,
			...env.env(),
			OPENAI_API_KEY: "test-token",
			PI_SESSION_ID: "a5-v2-full-pipeline",
		},
		encoding: "utf-8",
		timeout: 60_000,
	});
	stdout = result.stdout ?? "";
	stderr = result.stderr ?? "";
	exitCode = result.status ?? -1;

	const runsRoot = path.join(env.runDir, "runs", "git-commits-push-tl");
	if (!fs.existsSync(runsRoot)) {
		throw new Error(
			`Full pipeline did not create a Turnlock run directory (exit=${exitCode}). stderr=${stderr} stdout=${stdout}`,
		);
	}
	const runEntries = fs
		.readdirSync(runsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory());
	assert.strictEqual(runEntries.length, 1);
	const runEntry = runEntries[0];
	if (!runEntry) {
		throw new Error("Expected one Turnlock run directory");
	}
	turnlockRunDir = path.join(runsRoot, runEntry.name);
});

after(() => {
	repoDirty.dispose();
	env.dispose();
	fs.rmSync(searchRoot, { recursive: true, force: true });
});

describe("A5 — Turnlock v2 full CLI pipeline", () => {
	test("A5-01 | completes the production orchestrator-to-bridge-to-resume flow", () => {
		assert.strictEqual(exitCode, 0, `stderr=${stderr}\nstdout=${stdout}`);
		assert.ok(stdout.includes("[Turnlock→LLM] Received batch delegation"));
		assert.ok(stdout.includes("[Turnlock→LLM] Retry delegation detected"));
		assert.ok(stdout.includes("version: 2"));
		assert.ok(stdout.includes("action: DELEGATE"));
		assert.ok(stdout.includes("action: DONE"));
		assert.ok(!stdout.includes("action: ERROR"));
		assert.ok(stderr.includes("=== TURNLOCK EXECUTION REPORT ==="));
	});

	test("A5-02 | persists and consumes real v2 initial and retry delegations", () => {
		const state = JSON.parse(
			fs.readFileSync(path.join(turnlockRunDir, "state.json"), "utf-8"),
		) as { schemaVersion: number };
		const manifest = JSON.parse(
			fs.readFileSync(
				path.join(turnlockRunDir, "delegations", "commit-jobs-0.json"),
				"utf-8",
			),
		) as {
			manifestVersion: number;
			orchestratorName: string;
			kind: string;
			worker?: string;
			jobs: { id: string; resultPath: string }[];
		};

		assert.strictEqual(state.schemaVersion, 2);
		assert.strictEqual(manifest.manifestVersion, 2);
		assert.strictEqual(manifest.orchestratorName, "git-commits-push-tl");
		assert.strictEqual(manifest.kind, "batch");
		assert.strictEqual(manifest.worker, "git-commit-generator");
		assert.strictEqual(manifest.jobs.length, 1);
		const job = manifest.jobs[0];
		assert.notStrictEqual(job, undefined);
		if (!job) return;
		assert.strictEqual(fs.existsSync(job.resultPath), true);

		const delegationsDir = path.join(turnlockRunDir, "delegations");
		const retryManifestName = fs
			.readdirSync(delegationsDir)
			.find((name) => name.startsWith("commit-jobs-retry-"));
		assert.notStrictEqual(retryManifestName, undefined);
		if (!retryManifestName) return;
		const retryManifest = JSON.parse(
			fs.readFileSync(path.join(delegationsDir, retryManifestName), "utf-8"),
		) as {
			manifestVersion: number;
			kind: string;
			worker?: string;
		};
		assert.strictEqual(retryManifest.manifestVersion, 2);
		assert.strictEqual(retryManifest.kind, "batch");
		assert.strictEqual(retryManifest.worker, "git-commit-generator");
	});

	test("A5-03 | publishes the mocked LLM plan through the real Git publisher", () => {
		const result = spawnSync("git", ["log", "--oneline", "-1"], {
			cwd: repoDirty.dir,
			encoding: "utf-8",
		});
		assert.strictEqual(result.status, 0);
		assert.ok(result.stdout.includes("feat: complete v2 pipeline"));
	});
});
