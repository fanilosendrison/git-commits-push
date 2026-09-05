import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const RUN_ID = "01J00000000000000000000003";

interface RetryManifest {
	jobs: Array<{ id: string; prompt: string; resultPath: string }>;
}

let repository: GitRepoFixture | undefined;
let environment: MockTurnlockEnvironment | undefined;

afterEach(() => {
	repository?.dispose();
	environment?.dispose();
	repository = undefined;
	environment = undefined;
});

function overlongPlan(marker: string): CommitPlan {
	return {
		commit: {
			type: "feat",
			description: `${marker} ${"remains invalid and intentionally exceeds the subject boundary ".repeat(2)}`,
			isBreaking: false,
		},
		files: ["change.ts"],
	};
}

function result(repoId: string, plan: CommitPlan): CommitJobResultSuccess {
	return { success: true, id: repoId, commits: [plan] };
}

function listRetryManifests(runDir: string): string[] {
	const directory = path.join(
		runDir,
		"runs",
		"git-commits-push-tl",
		RUN_ID,
		"delegations",
	);
	return fs
		.readdirSync(directory)
		.filter((name) => name.startsWith("commit-jobs-retry-"))
		.sort()
		.map((name) => path.join(directory, name));
}

function readLatestRetryManifest(runDir: string): RetryManifest {
	const manifests = listRetryManifests(runDir);
	const latest = manifests.at(-1);
	assert.ok(latest);
	return JSON.parse(fs.readFileSync(latest, "utf8")) as RetryManifest;
}

function launchResume(env: MockTurnlockEnvironment) {
	return spawnSync(
		process.execPath,
		[SKILL_ENTRYPOINT, "--resume", "--run-id", RUN_ID],
		{
			env: {
				...process.env,
				...env.env(),
				PI_SESSION_ID: "test-validation-repair-bounds",
			},
			encoding: "utf8",
		},
	);
}

function writeDelegatedResult(
	manifest: RetryManifest,
	value: CommitJobResultSuccess,
) {
	const job = manifest.jobs[0];
	assert.ok(job);
	fs.mkdirSync(path.dirname(job.resultPath), { recursive: true });
	fs.writeFileSync(job.resultPath, JSON.stringify(value));
	return JSON.parse(job.prompt) as { model: string; mode: string };
}

describe("A3 — validation repair retry bounds", () => {
	test("permits two distinct primary repairs, one fallback, then terminates", async () => {
		environment = MockTurnlockEnvironment.create();
		repository = GitRepoFixture.create();
		const activeRepository = repository;
		activeRepository.commit("initial commit");
		activeRepository.writeAndStage(
			"change.ts",
			"export const changed = true;\n",
		);
		const { diffHash } = await import("../../src/utils/git-utils.ts").then(
			(module) => module.extractDiff(activeRepository.dir),
		);
		const repoId = await import("../../src/utils/git-utils.ts").then((module) =>
			module.computeRepoId(activeRepository.dir),
		);
		const settings: Settings = {
			searchPaths: [],
			provider: "mistral",
			model: "primary-model",
			fallbackProvider: "mistral",
			fallbackModel: "fallback-model",
			temperature: 0,
			systemPromptPath: "/nonexistent",
			autoPush: false,
			skipTests: true,
		};
		environment.writeSettings(settings);
		computeStateJson(
			environment.runDir,
			{
				repos: {
					[repoId]: {
						repository: activeRepository.dir,
						status: "RUNNING",
						diffHash,
						attempts: { validation: 0 },
					},
				},
			},
			RUN_ID,
		);
		environment.writeLLMResult(
			repoId,
			result(repoId, overlongPlan("initial")),
			RUN_ID,
		);
		const activeEnvironment = environment;

		const first = launchResume(activeEnvironment);
		assert.strictEqual(first.status, 0);
		assert.match(first.stdout, /action: DELEGATE/u);
		let manifest = readLatestRetryManifest(activeEnvironment.runDir);
		assert.strictEqual(listRetryManifests(activeEnvironment.runDir).length, 1);
		let payload = writeDelegatedResult(
			manifest,
			result(repoId, overlongPlan("primary-one")),
		);
		assert.strictEqual(payload.model, "primary-model");
		assert.strictEqual(payload.mode, "repair-commit-messages");

		const second = launchResume(activeEnvironment);
		assert.strictEqual(second.status, 0);
		assert.match(second.stdout, /action: DELEGATE/u);
		manifest = readLatestRetryManifest(activeEnvironment.runDir);
		assert.strictEqual(listRetryManifests(activeEnvironment.runDir).length, 2);
		payload = writeDelegatedResult(
			manifest,
			result(repoId, overlongPlan("primary-two")),
		);
		assert.strictEqual(payload.model, "primary-model");

		const third = launchResume(activeEnvironment);
		assert.strictEqual(third.status, 0);
		assert.match(third.stdout, /action: DELEGATE/u);
		manifest = readLatestRetryManifest(activeEnvironment.runDir);
		assert.strictEqual(listRetryManifests(activeEnvironment.runDir).length, 3);
		payload = writeDelegatedResult(
			manifest,
			result(repoId, overlongPlan("fallback")),
		);
		assert.strictEqual(payload.model, "fallback-model");

		const fourth = launchResume(activeEnvironment);
		assert.match(fourth.stdout, /action: ERROR/u);
		assert.ok(!fourth.stdout.includes("action: DELEGATE"));
		assert.strictEqual(listRetryManifests(activeEnvironment.runDir).length, 3);
	});
});
