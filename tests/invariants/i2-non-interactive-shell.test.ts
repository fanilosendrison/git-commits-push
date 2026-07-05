// NIB-T — Test I2: Non-Interactive Shell Safety (Global Invariant I1)
// Given: a push where git would normally prompt for credentials.
// Expected: push fails immediately (no hang), failure recorded in report.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { CommitJobResultSuccess } from "../../src/types.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";
import { computeStateJson } from "../helpers/test-helpers.ts";

let repoFakeRemote: GitRepoFixture;
let env: MockTurnlockEnvironment;
let repoId: string;

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dir,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

// Use an HTTPS URL that would require interactive credentials
const UNREACHABLE_HTTPS_REMOTE =
	"https://github.com/nonexistent-org/nonexistent-repo-xyz.git";

beforeAll(async () => {
	env = MockTurnlockEnvironment.create();
	repoFakeRemote = GitRepoFixture.create();
	repoFakeRemote.commit("initial commit");
	repoFakeRemote.writeAndStage("pushed.ts", "export const pushed = true;\n");
	// Register a remote that requires auth — GIT_TERMINAL_PROMPT=0 must prevent prompting
	repoFakeRemote.setRemote("origin", UNREACHABLE_HTTPS_REMOTE);

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

afterAll(() => {
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
			"bun",
			["run", SKILL_ENTRYPOINT, "--resume", "--run-id", "test-run-seeded"],
			{
				env: {
					...process.env,
					GIT_TERMINAL_PROMPT: "0", // explicitly set — matches Global Invariant I1
					...env.env(),
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
		expect(durationMs).toBeLessThan(10_000);
	});

	test("I2-02 | orchestrator delegates retry (transient push → retryable)", () => {
		// Phase 4 classifies PushError(transient=true) as retryable (network kind, 1 attempt),
		// so the orchestrator delegates again instead of reporting FAILED immediately.
		expect(stdout).toContain("action: DELEGATE");
		expect(stdout).toContain("commit-jobs-retry");
		// Stderr must NOT contain unhandled exceptions
		expect(stderr).not.toContain("Uncaught");
		expect(stderr).not.toContain("UnhandledPromiseRejection");
	});

	test("I2-03 | git commit WAS executed (commit succeeds, only push fails)", () => {
		const result = spawnSync("git", ["log", "--oneline", "-1"], {
			cwd: repoFakeRemote.dir,
			encoding: "utf-8",
		});
		expect(result.stdout).toContain("fix: push this");
	});
});
