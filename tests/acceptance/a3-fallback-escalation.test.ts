import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CommitJobResultSuccess, Settings } from "../../src/types.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";
import { computeStateJson } from "../helpers/test-helpers.ts";

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dir,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

interface RetryManifest {
	manifestVersion: number;
	kind: string;
	worker?: string;
	jobs: Array<{ id: string; prompt: string }>;
}

interface RetryPayload {
	provider: string;
	model: string;
	thinking?: boolean;
	feedback?: {
		previous_commit: string;
		errors: Array<{ kind: string; message: string }>;
	};
}

interface PersistedState {
	data: {
		repos: Record<
			string,
			{
				fallbackAttempted?: boolean;
				attempts?: Record<string, number>;
			}
		>;
	};
}

let repoDirty: GitRepoFixture | undefined;
let env: MockTurnlockEnvironment | undefined;

afterEach(() => {
	repoDirty?.dispose();
	env?.dispose();
	repoDirty = undefined;
	env = undefined;
});

function readRetryManifest(runDir: string, runId: string): RetryManifest {
	const delegationsDir = path.join(
		runDir,
		"runs",
		"git-commits-push-tl",
		runId,
		"delegations",
	);
	const manifestName = fs
		.readdirSync(delegationsDir)
		.find((name) => name.startsWith("commit-jobs-retry-"));
	expect(manifestName).toBeDefined();
	if (!manifestName) {
		throw new Error("Retry manifest was not written");
	}
	return JSON.parse(
		fs.readFileSync(path.join(delegationsDir, manifestName), "utf-8"),
	) as RetryManifest;
}

function readPersistedState(runDir: string, runId: string): PersistedState {
	return JSON.parse(
		fs.readFileSync(
			path.join(runDir, "runs", "git-commits-push-tl", runId, "state.json"),
			"utf-8",
		),
	) as PersistedState;
}

describe("A3 — Fallback model escalation", () => {
	test("exhausted validation retries delegate the next attempt to the fallback model", async () => {
		env = MockTurnlockEnvironment.create();
		const repo = GitRepoFixture.create();
		repoDirty = repo;
		repo.commit("initial commit");
		repo.writeAndStage("change.ts", "export const x = 1;\n");

		const { diffHash } = await import("../../src/utils/git-utils.ts").then(
			(m) => m.extractDiff(repo.dir),
		);
		const repoId = await import("../../src/utils/git-utils.ts").then((m) =>
			m.computeRepoId(repo.dir),
		);

		const settings: Settings = {
			searchPaths: [],
			provider: "deepseek",
			model: "deepseek-v4-flash",
			temperature: 0,
			systemPromptPath: "/nonexistent",
			autoPush: false,
			skipTests: true,
			thinking: true,
			fallbackProvider: "deepseek",
			fallbackModel: "deepseek-v4-pro",
		};
		env.writeSettings(settings);

		const runId = "test-run-fallback-escalation";
		computeStateJson(
			env.runDir,
			{
				repos: {
					[repoId]: {
						repository: repo.dir,
						status: "RUNNING",
						diffHash,
						attempts: {
							validation: 2,
							structural: 0,
							race: 0,
							git: 0,
							network: 0,
						},
					},
				},
			},
			runId,
		);

		const llmResult: CommitJobResultSuccess = {
			success: true,
			id: repoId,
			commits: [
				{
					commit: {
						type: "refactor",
						scope: "git-commits-push",
						description: "rename modules, remove legacy, update docs and tests",
						isBreaking: false,
					},
					files: ["change.ts"],
				},
			],
		};
		env.writeLLMResult(repoId, llmResult, runId);

		const result = spawnSync(
			"bun",
			["run", SKILL_ENTRYPOINT, "--resume", "--run-id", runId],
			{
				env: {
					...process.env,
					...env.env(),
					PI_SESSION_ID: "test-fallback-escalation",
				},
				encoding: "utf-8",
			},
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("action: DELEGATE");

		const manifest = readRetryManifest(env.runDir, runId);
		expect(manifest.manifestVersion).toBe(2);
		expect(manifest.kind).toBe("batch");
		expect(manifest.worker).toBe("git-commit-generator");
		expect(manifest.jobs).toHaveLength(1);
		const job = manifest.jobs[0];
		expect(job).toBeDefined();
		if (!job) {
			throw new Error("Retry manifest did not contain a job");
		}
		const payload = JSON.parse(job.prompt) as RetryPayload;

		expect(payload.provider).toBe("deepseek");
		expect(payload.model).toBe("deepseek-v4-pro");
		expect(payload.thinking).toBe(true);
		expect(payload.feedback?.errors[0]?.kind).toBe("validation");
		expect(payload.feedback?.errors[0]?.message).toContain(
			"Subject line trop long",
		);
		expect(payload.feedback?.previous_commit).toContain(
			"refactor(git-commits-push): rename modules",
		);

		const state = readPersistedState(env.runDir, runId);
		const repoState = state.data.repos[repoId];
		expect(repoState?.fallbackAttempted).toBe(true);
		expect(repoState?.attempts?.validation).toBe(0);
	});
});
