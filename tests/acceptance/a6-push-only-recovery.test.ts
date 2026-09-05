// A6 — Clean tracked repository push-only recovery
// Exercises discovery, validation, reporting, and an exact remote update without
// invoking the external LLM boundary.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";

const SKILL_ROOT = path.resolve(import.meta.dirname, "../..");
const ORCHESTRATOR_ENTRYPOINT = path.join(
	SKILL_ROOT,
	"src/entrypoints/turnlock-orchestrator.ts",
);
const BRIDGE_ENTRYPOINT = path.join(
	SKILL_ROOT,
	"src/entrypoints/turnlock-to-llm-bridge.ts",
);

let environment: MockTurnlockEnvironment;
let repository: GitRepoFixture;
let searchRoot: string;
let remoteRoot: string;
let remotePath: string;
let branch: string;
let expectedHead: string;
let execution: ReturnType<typeof spawnSync>;

function runGit(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

before(() => {
	environment = MockTurnlockEnvironment.create();
	searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "a6-push-only-"));
	remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "a6-push-remote-"));
	remotePath = path.join(remoteRoot, "remote.git");
	execFileSync("git", ["init", "--bare", remotePath]);

	repository = GitRepoFixture.create({ parentDir: searchRoot });
	repository.commit("initial");
	repository.setRemote("origin", remotePath);
	branch = runGit(repository.dir, [
		"symbolic-ref",
		"--quiet",
		"--short",
		"HEAD",
	]);
	execFileSync("git", ["push", "--set-upstream", "origin", branch], {
		cwd: repository.dir,
	});
	repository.writeAndStage(
		"published.ts",
		"export const publishedFromCleanTree = true;\n",
	);
	repository.commit("add clean push-only change");
	expectedHead = runGit(repository.dir, ["rev-parse", "HEAD"]);

	environment.writeSettings({
		searchPaths: [searchRoot],
		provider: "mistral",
		model: "mistral-medium-3.5",
		temperature: 0,
		systemPromptPath: path.join(searchRoot, "missing-system-prompt.md"),
		autoPush: true,
		skipTests: true,
		agent: "janet",
	});

	const command = [
		`${shellQuote("node")} ${shellQuote(ORCHESTRATOR_ENTRYPOINT)}`,
		`${shellQuote("node")} ${shellQuote(BRIDGE_ENTRYPOINT)}`,
	].join(" | ");
	execution = spawnSync("sh", ["-c", command], {
		cwd: SKILL_ROOT,
		env: {
			...process.env,
			...environment.env(),
			PI_SESSION_ID: "a6-push-only-recovery",
		},
		encoding: "utf8",
		timeout: 60_000,
	});
});

after(() => {
	repository.dispose();
	environment.dispose();
	fs.rmSync(searchRoot, { recursive: true, force: true });
	fs.rmSync(remoteRoot, { recursive: true, force: true });
});

describe("A6 — clean tracked push-only recovery", () => {
	test("checkpoints the push snapshot before publishing without invoking an LLM", () => {
		assert.strictEqual(
			execution.status,
			0,
			`stderr=${execution.stderr}\nstdout=${execution.stdout}`,
		);
		const remoteHead = runGit(remotePath, ["rev-parse", branch]);
		assert.strictEqual(remoteHead, expectedHead);
		assert.ok(
			String(execution.stderr).includes("=== TURNLOCK EXECUTION REPORT ==="),
		);
		assert.ok(!String(execution.stdout).includes("Invoking LLM"));

		const runRoot = path.join(
			environment.runDir,
			"runs",
			"git-commits-push-tl",
		);
		const runId = fs.readdirSync(runRoot)[0];
		assert.ok(runId);
		const state = JSON.parse(
			fs.readFileSync(path.join(runRoot, runId, "state.json"), "utf8"),
		);
		const persistedRepository = Object.values(state.data.repos)[0] as {
			operation?: string;
			pushSnapshot?: { validatedHeadSha?: string };
			status?: string;
		};
		assert.strictEqual(persistedRepository.operation, "push-only");
		assert.strictEqual(persistedRepository.status, "RUNNING");
		assert.strictEqual(
			persistedRepository.pushSnapshot?.validatedHeadSha,
			expectedHead,
		);
		const delegationPath = path.join(
			runRoot,
			runId,
			"delegations",
			"commit-jobs-0.json",
		);
		const delegation = JSON.parse(fs.readFileSync(delegationPath, "utf8"));
		const checkpointPayload = JSON.parse(delegation.jobs[0].prompt);
		assert.strictEqual(checkpointPayload.mode, "checkpoint-push-only");
	});
});
