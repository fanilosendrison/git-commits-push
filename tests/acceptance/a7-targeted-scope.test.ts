// tests/acceptance/a7-targeted-scope.test.ts — Targeted invocation-scope
// yield/resume acceptance coverage.
//
// Publication uses an ATTACHED target branch because explicit detached
// publication is owned by the explicit-target publication work (#7) and is
// intentionally not implemented by this Issue. The test proves the durable
// scope boundary: the initial targeted invocation persists the canonical
// InvocationScope, and resume without targeted CLI flags recovers it unchanged.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import type { CommitJobResultSuccess, Settings } from "../../src/types.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dirname,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

interface PersistedRunState {
	readonly data: {
		readonly invocationScope?: unknown;
		readonly repos: Record<string, { readonly repository?: string }>;
	};
}

let target: GitRepoFixture;
let unrelated: GitRepoFixture;
let env: MockTurnlockEnvironment;
let searchRoot: string;
let remoteRoot: string;
let targetBranch: string;
let initialStdout = "";
let initialExitCode = -1;
let resumeStdout = "";
let resumeStderr = "";
let resumeExitCode = -1;
let runId = "";
let repoId = "";
let scopeBefore: unknown;
let scopeAfter: unknown;
let reposBefore: Record<string, { readonly repository?: string }> = {};
let delegatedPrompts: readonly string[] = [];

function runGit(cwd: string, args: readonly string[]): string {
	return execFileSync("git", [...args], {
		cwd,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}

function readPersistedState(runDirectory: string): PersistedRunState {
	const statePath = path.join(runDirectory, "state.json");
	return JSON.parse(fs.readFileSync(statePath, "utf-8")) as PersistedRunState;
}

function runOrchestrator(extraArguments: readonly string[]): {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
} {
	const result = spawnSync(
		process.execPath,
		[SKILL_ENTRYPOINT, ...extraArguments],
		{
			env: {
				...process.env,
				...env.env(),
			},
			encoding: "utf-8",
		},
	);
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

before(async () => {
	env = MockTurnlockEnvironment.create();
	searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "a7-"));
	remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "a7-remote-"));
	const remotePath = path.join(remoteRoot, "remote.git");
	execFileSync("git", ["init", "--bare", remotePath]);

	// Target repository: normal attached branch with upstream publication.
	target = GitRepoFixture.create({ parentDir: searchRoot });
	target.commit("initial commit");
	target.setRemote("origin", remotePath);
	targetBranch = runGit(target.dir, [
		"symbolic-ref",
		"--quiet",
		"--short",
		"HEAD",
	]);
	runGit(target.dir, ["push", "--set-upstream", "origin", targetBranch]);
	target.writeAndStage("change.ts", "export const change = true;\n");

	// Unrelated dirty repository that global discovery would also select.
	unrelated = GitRepoFixture.create({ parentDir: searchRoot });
	unrelated.commit("initial commit");
	unrelated.writeAndStage("unrelated.ts", "export const unrelated = true;\n");

	const settings: Settings = {
		// searchPaths deliberately include the unrelated repository root.
		searchPaths: [searchRoot],
		provider: "anthropic",
		model: "claude-3-5-sonnet-20241022",
		temperature: 0,
		systemPromptPath: path.join(import.meta.dirname, "../../system-prompt.md"),
		autoPush: false,
		skipTests: true,
	};
	env.writeSettings(settings);

	const initial = runOrchestrator([
		"--repository",
		target.dir,
		"--push-remote",
		"origin",
		"--push-ref",
		`refs/heads/${targetBranch}`,
	]);
	initialStdout = initial.stdout;
	initialExitCode = initial.status ?? -1;

	const runRoot = path.join(env.runDir, "runs", "git-commits-push-tl");
	if (!fs.existsSync(runRoot)) return;
	const runIds = fs.readdirSync(runRoot);
	if (runIds.length !== 1) return;
	runId = runIds[0] ?? "";
	if (!runId) return;
	const runDirectory = path.join(runRoot, runId);
	const stateBefore = readPersistedState(runDirectory);
	scopeBefore = stateBefore.data.invocationScope;
	reposBefore = stateBefore.data.repos;

	const delegationPath = path.join(
		runDirectory,
		"delegations",
		"commit-jobs-0.json",
	);
	const delegation = JSON.parse(fs.readFileSync(delegationPath, "utf-8")) as {
		jobs: Array<{ prompt: string }>;
	};
	delegatedPrompts = delegation.jobs.map((job) => job.prompt);

	repoId = Object.keys(stateBefore.data.repos)[0] ?? "";
	if (!repoId) return;

	const llmResult: CommitJobResultSuccess = {
		success: true,
		id: repoId,
		commits: [
			{
				commit: {
					type: "feat",
					scope: "targeted",
					description: "publish targeted change",
					isBreaking: false,
				},
				files: ["change.ts"],
			},
		],
	};
	env.writeLLMResult(repoId, llmResult, runId);

	// Resume WITHOUT any targeted flags: persisted Turnlock state supplies the
	// scope and attached-branch publication flows through the current path.
	const resumed = runOrchestrator(["--resume", "--run-id", runId]);
	resumeStdout = resumed.stdout;
	resumeStderr = resumed.stderr;
	resumeExitCode = resumed.status ?? -1;

	const stateAfter = readPersistedState(runDirectory);
	scopeAfter = stateAfter.data.invocationScope;
});

after(() => {
	target.dispose();
	unrelated.dispose();
	env.dispose();
	fs.rmSync(searchRoot, { recursive: true, force: true });
	fs.rmSync(remoteRoot, { recursive: true, force: true });
});

describe("A7 — targeted invocation scope yield/resume", () => {
	test("A7-01 | initial targeted invocation exits 0", () => {
		assert.strictEqual(initialExitCode, 0);
	});

	test("A7-02 | initial invocation delegates only the targeted repository", () => {
		assert.ok(initialStdout.includes("@@TURNLOCK@@"));
		assert.ok(initialStdout.includes("action: DELEGATE"));
		assert.strictEqual(delegatedPrompts.length, 1);
		const payload = JSON.parse(delegatedPrompts[0] ?? "{}") as {
			repository?: string;
		};
		assert.strictEqual(payload.repository, fs.realpathSync(target.dir));
		assert.strictEqual(
			delegatedPrompts.some((prompt) => prompt.includes(unrelated.dir)),
			false,
		);
	});

	test("A7-03 | fresh targeted state persists the canonical InvocationScope", () => {
		assert.deepStrictEqual(scopeBefore, {
			kind: "targeted",
			repository: fs.realpathSync(target.dir),
			pushRemote: "origin",
			pushRef: `refs/heads/${targetBranch}`,
		});
		assert.deepStrictEqual(Object.keys(reposBefore), [repoId]);
		assert.strictEqual(
			reposBefore[repoId]?.repository,
			fs.realpathSync(target.dir),
		);
	});

	test("A7-04 | resume without targeted CLI flags exits 0", () => {
		assert.strictEqual(resumeExitCode, 0);
		assert.ok(resumeStdout.includes("action: DONE"));
		assert.ok(resumeStderr.includes("=== TURNLOCK EXECUTION REPORT ==="));
	});

	test("A7-05 | resume creates the commit through the existing publication path", () => {
		const log = runGit(target.dir, ["log", "--oneline", "-1"]);
		assert.ok(log.includes("feat(targeted): publish targeted change"));
	});

	test("A7-06 | resumed durable state keeps the exact targeted scope", () => {
		assert.deepStrictEqual(scopeAfter, scopeBefore);
		assert.deepStrictEqual(scopeAfter, {
			kind: "targeted",
			repository: fs.realpathSync(target.dir),
			pushRemote: "origin",
			pushRef: `refs/heads/${targetBranch}`,
		});
	});
});
