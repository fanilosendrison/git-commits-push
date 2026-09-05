import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import type {
	CommitJobResultSuccess,
	CommitPlan,
	Settings,
} from "../../src/types.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";
import { computeStateJson } from "../helpers/test-helpers.ts";

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dirname,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

interface RetryManifest {
	manifestVersion: number;
	kind: string;
	worker?: string;
	jobs: Array<{ id: string; prompt: string; resultPath: string }>;
}

interface RetryPayload {
	mode: string;
	provider: string;
	model: string;
	thinking?: boolean;
	diff?: string;
	rejectedPlans: Array<{
		commit: { type: string; description: string };
		files: string[];
	}>;
	validationErrors: Array<{ kind: string; message: string; planIndex: number }>;
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
	assert.notStrictEqual(manifestName, undefined);
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

function hashPlans(plans: CommitPlan[]): string {
	const canonical = plans
		.map((plan) => ({
			commit: {
				type: plan.commit.type,
				scope: plan.commit.scope ?? null,
				description: plan.commit.description,
				body: plan.commit.body ?? null,
				isBreaking: plan.commit.isBreaking,
			},
			files: [...plan.files].sort(),
		}))
		.sort((left, right) =>
			JSON.stringify(left).localeCompare(JSON.stringify(right)),
		);
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
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

		const runId = "01J00000000000000000000001";
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
			process.execPath,
			[SKILL_ENTRYPOINT, "--resume", "--run-id", runId],
			{
				env: {
					...process.env,
					...env.env(),
					PI_SESSION_ID: "test-fallback-escalation",
				},
				encoding: "utf-8",
			},
		);

		assert.strictEqual(result.status, 0);
		assert.ok(result.stdout.includes("action: DELEGATE"));

		const manifest = readRetryManifest(env.runDir, runId);
		assert.strictEqual(manifest.manifestVersion, 2);
		assert.strictEqual(manifest.kind, "batch");
		assert.strictEqual(manifest.worker, "git-commit-generator");
		assert.strictEqual(manifest.jobs.length, 1);
		const job = manifest.jobs[0];
		assert.notStrictEqual(job, undefined);
		if (!job) {
			throw new Error("Retry manifest did not contain a job");
		}
		const payload = JSON.parse(job.prompt) as RetryPayload;

		assert.strictEqual(payload.mode, "repair-commit-messages");
		assert.strictEqual(payload.provider, "deepseek");
		assert.strictEqual(payload.model, "deepseek-v4-pro");
		assert.strictEqual(payload.thinking, true);
		assert.strictEqual(payload.diff, undefined);
		assert.strictEqual(payload.validationErrors[0]?.kind, "validation");
		assert.strictEqual(payload.validationErrors[0]?.planIndex, 0);
		assert.ok(
			payload.validationErrors[0]?.message.includes("Subject line trop long"),
		);
		assert.strictEqual(
			payload.rejectedPlans[0]?.commit.description,
			"rename modules, remove legacy, update docs and tests",
		);

		const state = readPersistedState(env.runDir, runId);
		const repoState = state.data.repos[repoId];
		assert.strictEqual(repoState?.fallbackAttempted, true);
		assert.strictEqual(repoState?.attempts?.validation, 0);
	});

	test("an identical primary repair gets one fallback attempt and then terminates", async () => {
		env = MockTurnlockEnvironment.create();
		const repo = GitRepoFixture.create();
		repoDirty = repo;
		repo.commit("initial commit");
		repo.writeAndStage("change.ts", "export const x = 1;\n");
		const { diffHash } = await import("../../src/utils/git-utils.ts").then(
			(module) => module.extractDiff(repo.dir),
		);
		const repoId = await import("../../src/utils/git-utils.ts").then((module) =>
			module.computeRepoId(repo.dir),
		);
		const settings: Settings = {
			searchPaths: [],
			provider: "mistral",
			model: "mistral-medium-3.5",
			fallbackProvider: "mistral",
			fallbackModel: "mistral-medium-3.5",
			temperature: 0,
			systemPromptPath: "/nonexistent",
			autoPush: false,
			skipTests: true,
		};
		env.writeSettings(settings);
		const plan: CommitPlan = {
			commit: {
				type: "feat",
				description:
					"complete the delegated pipeline with durable retry processing support",
				isBreaking: false,
			},
			files: ["change.ts"],
		};
		const runId = "01J00000000000000000000002";
		computeStateJson(
			env.runDir,
			{
				repos: {
					[repoId]: {
						repository: repo.dir,
						status: "RUNNING",
						diffHash,
						attempts: { validation: 1 },
						lastPlanHash: hashPlans([plan]),
					},
				},
			},
			runId,
		);
		const llmResult: CommitJobResultSuccess = {
			success: true,
			id: repoId,
			commits: [plan],
		};
		env.writeLLMResult(repoId, llmResult, runId);
		const activeEnvironment = env;
		const launch = (env: MockTurnlockEnvironment) =>
			spawnSync(
				process.execPath,
				[SKILL_ENTRYPOINT, "--resume", "--run-id", runId],
				{
					env: {
						...process.env,
						...env.env(),
						PI_SESSION_ID: "test-identical-repair-fallback",
					},
					encoding: "utf-8",
				},
			);

		const firstResult = launch(activeEnvironment);
		assert.strictEqual(firstResult.status, 0);
		assert.ok(firstResult.stdout.includes("action: DELEGATE"));
		const manifest = readRetryManifest(env.runDir, runId);
		assert.strictEqual(manifest.jobs.length, 1);
		const fallbackJob = manifest.jobs[0];
		assert.ok(fallbackJob);
		if (!fallbackJob) throw new Error("Fallback job was not emitted");
		const payload = JSON.parse(fallbackJob.prompt) as RetryPayload;
		assert.strictEqual(payload.mode, "repair-commit-messages");
		assert.strictEqual(payload.model, "mistral-medium-3.5");
		fs.mkdirSync(path.dirname(fallbackJob.resultPath), { recursive: true });
		fs.writeFileSync(
			fallbackJob.resultPath,
			JSON.stringify(llmResult),
			"utf-8",
		);

		const secondResult = launch(activeEnvironment);
		assert.ok(
			secondResult.stdout.includes("action: ERROR"),
			`stderr=${secondResult.stderr}\nstdout=${secondResult.stdout}`,
		);
		assert.ok(!secondResult.stdout.includes("action: DELEGATE"));
		const state = readPersistedState(env.runDir, runId);
		assert.strictEqual(state.data.repos[repoId]?.fallbackAttempted, true);
	});
});
