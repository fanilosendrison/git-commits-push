// NIB-T — Test I2: Non-Interactive Shell Safety (Global Invariant I1)
// Given: a push where git would normally prompt for credentials.
// Expected: push fails immediately (no hang), failure recorded in report.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import type { CommitJobResultSuccess } from "../../src/types.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";
import { computeStateJson } from "../helpers/test-helpers.ts";

let repoFakeRemote: GitRepoFixture;
let env: MockTurnlockEnvironment;
let repoId: string;
let authServer: ChildProcess;

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dirname,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);
const AUTH_REMOTE_FIXTURE = path.resolve(
	import.meta.dirname,
	"../fixtures/http-auth-remote.mjs",
);

function startAuthRemote(): Promise<number> {
	authServer = spawn(process.execPath, [AUTH_REMOTE_FIXTURE], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("HTTP auth fixture startup timed out")),
			10_000,
		);
		authServer.once("error", reject);
		authServer.stdout?.once("data", (chunk) => {
			clearTimeout(timeout);
			resolve(Number.parseInt(chunk.toString("utf8").trim(), 10));
		});
	});
}

before(async () => {
	env = MockTurnlockEnvironment.create();
	const authRemotePort = await startAuthRemote();
	repoFakeRemote = GitRepoFixture.create();
	repoFakeRemote.commit("initial commit");
	repoFakeRemote.writeAndStage("pushed.ts", "export const pushed = true;\n");
	// A local HTTP 401 challenge would prompt without GIT_TERMINAL_PROMPT=0.
	repoFakeRemote.setRemote(
		"origin",
		`http://127.0.0.1:${authRemotePort}/repository.git`,
	);

	repoId = await import("../../src/utils/git-utils.ts").then((m) =>
		m.computeRepoId(repoFakeRemote.dir),
	);

	const { diffHash } = await import("../../src/utils/git-utils.ts").then((m) =>
		m.extractDiff(repoFakeRemote.dir),
	);

	env.writeSettings({
		searchPaths: [],
		provider: "anthropic",
		model: "claude-3-5-sonnet-20241022",
		temperature: 0,
		systemPromptPath: "/nonexistent",
		autoPush: true,
		skipTests: true,
	});

	computeStateJson(env.runDir, {
		repos: {
			[repoId]: {
				repository: repoFakeRemote.dir,
				status: "SUCCESS",
				diffHash,
			},
		},
	});

	const llmResult: CommitJobResultSuccess = {
		success: true,
		id: repoId,
		commits: [
			{
				commit: { type: "fix", description: "push this", isBreaking: false },
				files: ["pushed.ts"],
			},
		],
	};
	env.writeLLMResult(repoId, llmResult);
});

after(() => {
	authServer.kill("SIGTERM");
	repoFakeRemote.dispose();
	env.dispose();
});

describe("I2 — Non-Interactive Shell Safety", () => {
	let stderr: string;
	let stdout: string;
	let durationMs: number;

	test("I2-01 | process completes within 10 seconds (no hang)", () => {
		const start = Date.now();
		const result = spawnSync(
			process.execPath,
			[SKILL_ENTRYPOINT, "--resume", "--run-id", "01J00000000000000000000000"],
			{
				env: {
					...process.env,
					...env.env(),
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_TERMINAL_PROMPT: "0",
					HOME: env.runDir,
					XDG_CONFIG_HOME: env.runDir,
				},
				encoding: "utf-8",
				timeout: 10_000, // fail-safe: bun will kill if it hangs
			},
		);
		durationMs = Date.now() - start;
		stderr = result.stderr ?? "";
		stdout = result.stdout ?? "";
		// We do not assert exit code 0 here — the push WILL fail, but gracefully
		// The important thing is that it does NOT hang
		assert.ok(durationMs < 10_000);
	});

	test("I2-02 | post-commit push failure never delegates another LLM plan", () => {
		// The exact commit already exists locally. Publication failure is terminal for
		// this run so a later invocation can use push-only recovery without recreating it.
		assert.ok(!stdout.includes("action: DELEGATE"));
		assert.ok(!stdout.includes("commit-jobs-retry"));
		assert.ok(stdout.includes("action: ERROR"));
		assert.ok(stderr.includes("Failed."));
		assert.ok(!stderr.includes("Uncaught"));
		assert.ok(!stderr.includes("UnhandledPromiseRejection"));
	});

	test("I2-03 | git commit WAS executed (commit succeeds, only push fails)", () => {
		const result = spawnSync("git", ["log", "--oneline", "-1"], {
			cwd: repoFakeRemote.dir,
			encoding: "utf-8",
		});
		assert.ok(result.stdout.includes("fix: push this"));
	});
});
