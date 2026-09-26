// A8 — Legacy global InvocationScope is parseable but non-executable.
// The current runtime may open historical global state for compatibility, but it
// must refuse to execute any phase from it before repository mutation.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import type { CommitJobResultSuccess, Settings } from "../../src/types.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";
import {
	captureRepositoryState,
	computeStateJson,
} from "../helpers/test-helpers.ts";

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dirname,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

interface LegacyGlobalFixture {
	readonly env: MockTurnlockEnvironment;
	readonly repo: GitRepoFixture;
	readonly result: ReturnType<typeof spawnSync>;
	readonly before: string;
}

/** Persist a converged-at-commit-and-push legacy global run and resume it. */
async function runLegacyGlobalResume(
	runId: string,
	omitInvocationScope: boolean,
): Promise<LegacyGlobalFixture> {
	const env = MockTurnlockEnvironment.create();
	const repo = GitRepoFixture.create();
	repo.commit("initial commit");
	repo.writeAndStage("legacy-change.ts", "export const legacyChange = true;\n");

	const { diffHash } = await import("../../src/utils/git-utils.ts").then((m) =>
		m.extractDiff(repo.dir),
	);
	const repoId = await import("../../src/utils/git-utils.ts").then((m) =>
		m.computeRepoId(repo.dir),
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

	computeStateJson(
		env.runDir,
		{
			invocationScope: { kind: "global" },
			repos: {
				[repoId]: {
					repository: repo.dir,
					status: "SUCCESS",
					diffHash,
				},
			},
		},
		runId,
	);

	if (omitInvocationScope) {
		const statePath = path.join(
			env.runDir,
			"runs",
			"git-commits-push-tl",
			runId,
			"state.json",
		);
		const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
			data: Record<string, unknown>;
		};
		delete state.data.invocationScope;
		fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
	}

	const llmResult: CommitJobResultSuccess = {
		success: true,
		id: repoId,
		commits: [
			{
				commit: {
					type: "feat",
					description: "publish legacy change",
					isBreaking: false,
				},
				files: ["legacy-change.ts"],
			},
		],
	};
	env.writeLLMResult(repoId, llmResult, runId);

	const before = captureRepositoryState(repo.dir);
	const result = spawnSync(
		process.execPath,
		[SKILL_ENTRYPOINT, "--resume", "--run-id", runId],
		{
			env: {
				...process.env,
				...env.env(),
			},
			encoding: "utf-8",
		},
	);
	return { before, env, repo, result };
}

/** The execution fails closed and the repository remains byte-identical. */
function assertBlockedLegacyGlobalOutcome(fixture: LegacyGlobalFixture): void {
	const stdout = fixture.result.stdout ?? "";
	const stderr = fixture.result.stderr ?? "";
	const diagnostics = `${stdout}\n${stderr}`;
	assert.match(diagnostics, /legacy global/);
	assert.match(diagnostics, /non-executable/);
	assert.ok(!stdout.includes("action: DONE"), diagnostics);
	assert.ok(
		(fixture.result.status ?? 0) !== 0 || stdout.includes("action: ERROR"),
		`expected a blocked execution, got status=${String(fixture.result.status)}\n${diagnostics}`,
	);
	assert.deepStrictEqual(
		captureRepositoryState(fixture.repo.dir),
		fixture.before,
	);
}

describe("A8 — legacy global InvocationScope is non-executable", () => {
	test("A8-01 | explicit persisted global scope cannot resume commit/push", async () => {
		const fixture = await runLegacyGlobalResume(
			"01J00000000000000000000001",
			false,
		);
		try {
			assertBlockedLegacyGlobalOutcome(fixture);
		} finally {
			fixture.repo.dispose();
			fixture.env.dispose();
		}
	});

	test("A8-02 | historical missing invocationScope normalizes to global but cannot resume", async () => {
		const fixture = await runLegacyGlobalResume(
			"01J00000000000000000000002",
			true,
		);
		try {
			assertBlockedLegacyGlobalOutcome(fixture);
		} finally {
			fixture.repo.dispose();
			fixture.env.dispose();
		}
	});
});
