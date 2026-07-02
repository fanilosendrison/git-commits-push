// NIB-T — Test A2: End-to-End Resume Run (Phases 4, 5)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";
import type { CommitJobResultSuccess, Settings } from "../../src/types.ts";
import { computeStateJson } from "../helpers/test-helpers.ts";

let repoDirty: GitRepoFixture;
let env: MockTurnlockEnvironment;
let repoId: string;

const SKILL_ENTRYPOINT = path.resolve(import.meta.dir, "../../src/entrypoints/turnlock-orchestrator.ts");

beforeAll(async () => {
	env = MockTurnlockEnvironment.create();
	repoDirty = GitRepoFixture.create();
	repoDirty.commit("initial commit");
	repoDirty.writeAndStage("change.ts", "export const x = 1;\n");

	// Compute the diffHash of the current staged state via the helper the production
	// code will expose. Since this is RED phase, this import will fail.
	const { diffHash, diff } = await import("../../src/utils/git-utils.ts").then((m) =>
		m.extractDiff(repoDirty.dir),
	);

	repoId = await import("../../src/utils/git-utils.ts").then((m) =>
		m.computeRepoId(repoDirty.dir),
	);

	const settings: Settings = {
		searchPaths: [],
		provider: "anthropic",
		model: "claude-3-5-sonnet-20241022",
		temperature: 0,
		systemPromptPath: "/nonexistent",
		autoPush: false,
		skipTests: true,
	};

	env.writeSettings(settings);

	// Pre-write the state.json that Turnlock would have persisted after Phase 3
	computeStateJson(env.runDir, {
		repos: {
			[repoId]: {
				repository: repoDirty.dir,
				status: "SUCCESS",
				diffHash,
			},
		},
	}, "test-run-seeded");

	// Simulate the LLM wrapper having written a valid result for the job
	const llmResult: CommitJobResultSuccess = {
		success: true,
		id: repoId,
		commits: [
			{
				commit: {
					type: "feat",
					scope: "core",
					description: "add x constant",
					isBreaking: false,
				},
				files: ["change.ts"],
			},
		],
	};
	env.writeLLMResult(repoId, llmResult, "test-run-seeded");
	void diff; // used implicitly via computeStateJson
});

afterAll(() => {
	repoDirty.dispose();
	env.dispose();
});

describe("A2 — End-to-End Resume Run", () => {
	let stdout: string;
	let stderr: string;
	let exitCode: number;

	test("A2-01 | skill process exits with code 0 on --resume", () => {
		const result = spawnSync(
			"bun",
			["run", SKILL_ENTRYPOINT, "--resume", "--run-id", "test-run-seeded"],
			{
				env: {
					...process.env,
					TURNLOCK_RUN_DIR_ROOT: path.join(env.runDir, "runs"),
				TURNLOCK_SKILL_SETTINGS_PATH: path.join(env.runDir, "settings.json"),
				},
				encoding: "utf-8",
			},
		);
		stdout = result.stdout ?? "";
		stderr = result.stderr ?? "";
		exitCode = result.status ?? -1;
		expect(exitCode).toBe(0);
	});

	test("A2-02 | stdout contains Turnlock DONE block", () => {
		expect(stdout).toContain("@@TURNLOCK@@");
		expect(stdout).toContain("action: DONE");
	});

	test("A2-03 | Phase 5 report is emitted to stderr", () => {
		// Phase 5 human-readable output goes to stderr (not stdout — DC-TURNLOCK I4 compliance)
		expect(stderr).toContain("=== TURNLOCK EXECUTION REPORT ===");
	});

	test("A2-04 | Phase 5 report lists repo-dirty as success", () => {
		expect(stderr).toContain(repoId);
		expect(stderr).toContain("✅");
	});

	test("A2-05 | git commit was created in repo-dirty", () => {
		const result = spawnSync("git", ["log", "--oneline", "-1"], {
			cwd: repoDirty.dir,
			encoding: "utf-8",
		});
		expect(result.stdout).toContain("feat(core): add x constant");
	});

	test("A2-06 | only one commit was created (single plan)", () => {
		const result = spawnSync("git", ["log", "--oneline"], {
			cwd: repoDirty.dir,
			encoding: "utf-8",
		});
		// "initial commit" + the one we just made = 2 total
		expect(result.stdout.trim().split("\n").length).toBe(2);
	});
});
