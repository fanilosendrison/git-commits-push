// NIB-T — Test I2: Non-Interactive Shell Safety (Global Invariant I1)
// Given: a push where git would normally prompt for credentials.
// Expected: push fails immediately (no hang), failure recorded in report.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { captureValidatedSource } from "../../src/modules/git/validated-source.ts";
import type { CommitJobResultSuccess } from "../../src/types.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";
import { reportSourceResume } from "../fixtures/resume-reporting.ts";
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
		invocationScope: {
			kind: "worktree",
			repository: fs.realpathSync(repoFakeRemote.dir),
		},
		repos: {
			[repoId]: {
				repository: repoFakeRemote.dir,
				operation: "commit-and-push",
				validatedSource: captureValidatedSource(repoFakeRemote.dir, true),
				status: "RUNNING",
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

	test("I2-01 | process terminates without hitting the fail-safe timeout (no hang)", () => {
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
				timeout: 60_000, // fail-safe only: a credential-prompt hang is killed here
			},
		);
		durationMs = Date.now() - start;
		// Preserve the original watchdog output even if the following assertion fails.
		stderr = result.stderr ?? "";
		stdout = result.stdout ?? "";
		// This interval covers the actual source-resume process, not a second
		// no-effect reporting process with its own independent fail-safe.
		// We do not assert exit code 0 here — the push WILL fail, but gracefully.
		// The invariant is absence of a credential-prompt hang, so the fail-safe
		// timeout must remain untouched; host slowness must not fail this test.
		assert.ok(
			result.error === undefined,
			`process was killed by the fail-safe timeout: ${String(result.error)}`,
		);
		assert.ok(durationMs < 60_000);
		const reportStart = Date.now();
		const reported = reportSourceResume(process.execPath, result, {
			env: {
				...process.env,
				...env.env(),
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_TERMINAL_PROMPT: "0",
				HOME: env.runDir,
				XDG_CONFIG_HOME: env.runDir,
			},
			encoding: "utf-8",
			timeout: 60_000,
		});
		assert.equal(reported.error, undefined);
		assert.ok(Date.now() - reportStart < 60_000);
		stderr = reported.stderr ?? "";
		stdout = reported.stdout ?? "";
	});

	test("I2-02 | post-commit push failure never delegates another LLM plan", () => {
		// The exact commit already exists locally. Publication failure is terminal for
		// this run so a later invocation can use push-only recovery without recreating it.
		assert.ok(stdout.includes("commit-outcome"));
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
