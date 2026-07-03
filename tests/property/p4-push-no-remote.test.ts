// NIB-T — Test P4: Git Push Skip No-Remote (Phase 4)
// Given: a repository with no remotes configured.
// Expected: the push step is gracefully skipped, repo status = SUCCESS.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { CommitJobResultSuccess } from "../../src/types.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";
import { computeStateJson } from "../helpers/test-helpers.ts";

let repoNoRemote: GitRepoFixture;
let env: MockTurnlockEnvironment;
let repoId: string;

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dir,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

beforeAll(async () => {
	env = MockTurnlockEnvironment.create();
	repoNoRemote = GitRepoFixture.create();
	repoNoRemote.commit("initial commit");
	repoNoRemote.writeAndStage("isolated.ts", "export const iso = true;\n");
	// Intentionally: no remote is added.

	repoId = await import("../../src/utils/git-utils.ts").then((m) =>
		m.computeRepoId(repoNoRemote.dir),
	);

	const { diffHash } = await import("../../src/utils/git-utils.ts").then((m) =>
		m.extractDiff(repoNoRemote.dir),
	);

	env.writeSettings({
		searchPaths: [],
		provider: "anthropic",
		model: "claude-3-5-sonnet-20241022",
		temperature: 0,
		systemPromptPath: "/nonexistent",
		autoPush: true, // push is requested, but there's no remote to push to
		skipTests: true,
	});

	computeStateJson(env.runDir, {
		repos: {
			[repoId]: {
				repository: repoNoRemote.dir,
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
				commit: {
					type: "chore",
					description: "isolated change",
					isBreaking: false,
				},
				files: ["isolated.ts"],
			},
		],
	};
	env.writeLLMResult(repoId, llmResult);
});

afterAll(() => {
	repoNoRemote.dispose();
	env.dispose();
});

describe("P4 — Git Push Skip No-Remote", () => {
	let stderr: string;
	let exitCode: number;

	test("P4-01 | process exits with code 0", () => {
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
		exitCode = result.status ?? -1;
		expect(exitCode).toBe(0);
	});

	test("P4-02 | repo is reported as SUCCESS despite no remote", () => {
		expect(stderr).toContain("✅");
		expect(stderr).toContain(repoId);
	});

	test("P4-03 | git commit was still created in the repo", () => {
		const result = spawnSync("git", ["log", "--oneline", "-1"], {
			cwd: repoNoRemote.dir,
			encoding: "utf-8",
		});
		expect(result.stdout).toContain("chore: isolated change");
	});
});
