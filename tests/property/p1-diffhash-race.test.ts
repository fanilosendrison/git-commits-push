// NIB-T — Test P1: DiffHash Race Condition Prevention (Phase 4)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { CommitJobResultSuccess } from "../../src/types.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";
import { computeStateJson } from "../helpers/test-helpers.ts";

let repoDirty: GitRepoFixture;
let env: MockTurnlockEnvironment;
let repoId: string;

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dir,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

const STALE_DIFF_HASH =
	"sha256:0000000000000000000000000000000000000000000000000000000000000000";

beforeAll(async () => {
	env = MockTurnlockEnvironment.create();
	repoDirty = GitRepoFixture.create();
	repoDirty.commit("initial commit");
	repoDirty.writeAndStage("change.ts", "export const x = 1;\n");

	repoId = await import("../../src/utils/git-utils.ts").then((m) =>
		m.computeRepoId(repoDirty.dir),
	);

	const settings = {
		searchPaths: [],
		provider: "anthropic",
		model: "claude-3-5-sonnet-20241022",
		temperature: 0,
		systemPromptPath: "/nonexistent",
		autoPush: false,
		skipTests: true,
	};
	env.writeSettings(settings);

	// State records a STALE diffHash — this simulates user modifying the repo
	// between Phase 2 and Phase 4.
	computeStateJson(env.runDir, {
		repos: {
			[repoId]: {
				repository: repoDirty.dir,
				status: "SUCCESS",
				diffHash: STALE_DIFF_HASH, // intentionally wrong
			},
		},
	});

	const llmResult: CommitJobResultSuccess = {
		success: true,
		id: repoId,
		commits: [
			{
				commit: {
					type: "feat",
					description: "add x constant",
					isBreaking: false,
				},
				files: ["change.ts"],
			},
		],
	};
	env.writeLLMResult(repoId, llmResult);
});

afterAll(() => {
	repoDirty.dispose();
	env.dispose();
});

describe("P1 — DiffHash Race Condition Prevention", () => {
	let stdout: string;

	test("P1-01 | process exits with code 0 (partial success path)", () => {
		const result = spawnSync(
			"bun",
			["run", SKILL_ENTRYPOINT, "--resume", "--run-id", "test-run-seeded"],
			{
				env: {
					...process.env,
					...env.env(),
				},
				encoding: "utf-8",
			},
		);
		stdout = result.stdout ?? "";
		// The orchestration itself succeeds but the repo worker fails gracefully
		expect(result.status).toBe(0);
	});

	test("P1-02 | orchestrator delegates retry (race → retryable)", () => {
		// Phase 4 classifies DiffHashMismatchError as retryable (race kind, 1 attempt),
		// so the orchestrator delegates again instead of reporting FAILED immediately.
		expect(stdout).toContain("action: DELEGATE");
	});

	test("P1-03 | retry label starts with 'commit-jobs-retry'", () => {
		expect(stdout).toContain("commit-jobs-retry");
	});

	test("P1-04 | git commit was NOT executed in repo-dirty", () => {
		const result = spawnSync("git", ["log", "--oneline", "-1"], {
			cwd: repoDirty.dir,
			encoding: "utf-8",
		});
		// Only the initial commit should exist — no auto-generated commit
		expect(result.stdout).toContain("initial commit");
		expect(result.stdout).not.toContain("add x constant");
	});
});
