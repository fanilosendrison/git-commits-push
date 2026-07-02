// NIB-T — Test P3: Git Push Upstream Fallback (Phase 4)
// Given: a repo with a non-'origin' remote and no upstream configured.
// Expected: push falls back to `git push -u <remote> <branch>` automatically.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";
import type { CommitJobResultSuccess } from "../../src/types.ts";
import { computeStateJson } from "../helpers/test-helpers.ts";

let repoSource: GitRepoFixture;
let repoBare: GitRepoFixture; // acts as the "remote" server
let env: MockTurnlockEnvironment;
let repoId: string;

const SKILL_ENTRYPOINT = path.resolve(import.meta.dir, "../../src/entrypoints/turnlock-orchestrator.ts");

beforeAll(async () => {
	env = MockTurnlockEnvironment.create();

	// Create a bare repository to serve as the push target
	repoBare = GitRepoFixture.create();
	fs.rmSync(path.join(repoBare.dir, ".git"), { recursive: true, force: true });
	// Re-initialize as a bare repo
	spawnSync("git", ["init", "--bare", repoBare.dir], { encoding: "utf-8" });

	repoSource = GitRepoFixture.create();
	repoSource.commit("initial commit");
	repoSource.writeAndStage("feature.ts", "export const z = 3;\n");

	// Register the bare repo as 'custom-remote' — no 'origin' exists
	repoSource.setRemote("custom-remote", repoBare.dir);

	repoId = await import("../../src/utils/git-utils.ts").then((m) =>
		m.computeRepoId(repoSource.dir),
	);

	const { diffHash } = await import("../../src/utils/git-utils.ts").then((m) =>
		m.extractDiff(repoSource.dir),
	);

	env.writeSettings({
		searchPaths: [],
		provider: "anthropic",
		model: "claude-3-5-sonnet-20241022",
		temperature: 0,
		systemPromptPath: "/nonexistent",
		autoPush: true, // push is enabled
		skipTests: true,
	});

	computeStateJson(env.runDir, {
		repos: {
			[repoId]: {
				repository: repoSource.dir,
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
				commit: { type: "feat", description: "add z constant", isBreaking: false },
				files: ["feature.ts"],
			},
		],
	};
	env.writeLLMResult(repoId, llmResult);
});

afterAll(() => {
	repoSource.dispose();
	repoBare.dispose();
	env.dispose();
});

describe("P3 — Git Push Upstream Fallback", () => {
	let stderr: string;

	test("P3-01 | process exits with code 0", () => {
		const result = spawnSync(
			"bun",
			["run", SKILL_ENTRYPOINT, "--resume", "--run-id", "test-run-seeded"],
			{
				env: {
					...process.env,
					GIT_TERMINAL_PROMPT: "0",
					TURNLOCK_RUN_DIR_ROOT: path.join(env.runDir, "runs"),
				TURNLOCK_SKILL_SETTINGS_PATH: path.join(env.runDir, "settings.json"),
				},
				encoding: "utf-8",
			},
		);
		stderr = result.stderr ?? "";
		expect(result.status).toBe(0);
	});

	test("P3-02 | repo is reported as SUCCESS", () => {
		expect(stderr).toContain("✅");
		expect(stderr).toContain(repoId);
	});

	test("P3-03 | commit was pushed to the bare remote", () => {
		// Verify the bare repo received the commit
		const result = spawnSync("git", ["log", "--oneline", "-1"], {
			cwd: repoBare.dir,
			encoding: "utf-8",
		});
		expect(result.stdout).toContain("feat: add z constant");
	});
});
