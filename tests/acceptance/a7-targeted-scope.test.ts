// tests/acceptance/a7-targeted-scope.test.ts — Detached-HEAD targeted
// publication, one pass from a linked task worktree.
//
// Fixture: a bare remote, a persistent checkout on `main`, a linked task
// worktree detached from that exact main baseline, and an unrelated dirty
// repository under the same broad searchPaths. The initial targeted invocation
// freezes the destination and yields for the LLM; the resume without any
// targeted flag commits on the detached HEAD and publishes the exact result.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import type { CommitJobResultSuccess, Settings } from "../../src/types.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";
import { resumeWithReporting } from "../fixtures/resume-reporting.ts";

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dirname,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

interface PersistedRunState {
	readonly data: {
		readonly invocationScope?: unknown;
		readonly repos: Record<
			string,
			{
				readonly repository?: string;
				readonly operation?: string;
				readonly status?: string;
				readonly explicitPushTargetSnapshot?: unknown;
				readonly remoteTrackingRefSynchronization?: string;
			}
		>;
	};
}

interface RunReceipt {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

let env: MockTurnlockEnvironment;
let searchRoot: string;
let remoteRoot: string;
let remotePath: string;
let persistent: GitRepoFixture;
let unrelated: GitRepoFixture;
let taskPath: string;
let mainBranch: string;
let baseline: string;

let persistentBefore: Record<string, string>;
let unrelatedBefore: Record<string, string>;
let initial: RunReceipt;
let resumed: RunReceipt;
let runDirectory = "";
let runId = "";
let repoId = "";
let scopeBefore: unknown;
let scopeAfter: unknown;
let frozenTargetBefore: unknown;
let frozenTargetAfter: unknown;
let delegatedPrompts: readonly string[] = [];
let taskHeadAfter = "";
let persistedStateText = "";

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", [...args], {
		cwd,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}

/** Everything the targeted run must leave untouched in a checkout. */
function captureCheckoutState(
	repository: GitRepoFixture,
): Record<string, string> {
	const state: Record<string, string> = {
		head: git(repository.dir, ["rev-parse", "HEAD"]),
		status: git(repository.dir, [
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
		]),
		index: git(repository.dir, ["ls-files", "--stage"]),
		config: git(repository.dir, ["config", "--local", "--list"]),
	};
	try {
		const branch = git(repository.dir, [
			"symbolic-ref",
			"--quiet",
			"--short",
			"HEAD",
		]);
		state.branch = branch;
		state.branchSha = git(repository.dir, [
			"rev-parse",
			`refs/heads/${branch}`,
		]);
	} catch {
		state.branch = "detached";
	}
	return state;
}

function runOrchestrator(extraArguments: readonly string[]): RunReceipt {
	const result = resumeWithReporting(
		process.execPath,
		[SKILL_ENTRYPOINT, ...extraArguments],
		{ env: { ...process.env, ...env.env() }, encoding: "utf-8" },
	);
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function readPersistedState(targetRunDirectory: string): PersistedRunState {
	return JSON.parse(
		fs.readFileSync(path.join(targetRunDirectory, "state.json"), "utf-8"),
	) as PersistedRunState;
}

before(() => {
	env = MockTurnlockEnvironment.create();
	searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "a7-"));
	remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "a7-remote-"));
	remotePath = path.join(remoteRoot, "remote.git");
	execFileSync("git", ["init", "--bare", remotePath], { stdio: "pipe" });

	persistent = GitRepoFixture.create({ parentDir: searchRoot });
	persistent.commit("initial commit");
	persistent.setRemote("origin", remotePath);
	mainBranch = git(persistent.dir, [
		"symbolic-ref",
		"--quiet",
		"--short",
		"HEAD",
	]);
	git(persistent.dir, ["push", "--set-upstream", "origin", mainBranch]);
	baseline = git(persistent.dir, ["rev-parse", "HEAD"]);
	// Persistent work in progress that targeted mode must never touch.
	fs.writeFileSync(
		path.join(persistent.dir, "persistent-wip.ts"),
		"export const pending = true;\n",
	);

	// Linked task worktree detached from the exact main baseline.
	taskPath = path.join(fs.realpathSync(searchRoot), "task-worktree");
	git(persistent.dir, ["worktree", "add", "--detach", taskPath, baseline]);
	fs.writeFileSync(
		path.join(taskPath, "task-change.ts"),
		"export const taskChange = true;\n",
	);

	// Unrelated dirty repository that global discovery would also select.
	unrelated = GitRepoFixture.create({ parentDir: searchRoot });
	unrelated.commit("initial commit");
	unrelated.writeAndStage("unrelated.ts", "export const unrelated = true;\n");

	const settings: Settings = {
		searchPaths: [searchRoot],
		provider: "anthropic",
		model: "claude-3-5-sonnet-20241022",
		temperature: 0,
		systemPromptPath: path.join(import.meta.dirname, "../../system-prompt.md"),
		// The targeted path must publish even with autoPush disabled.
		autoPush: false,
		skipTests: true,
	};
	env.writeSettings(settings);

	persistentBefore = captureCheckoutState(persistent);
	unrelatedBefore = captureCheckoutState(unrelated);

	initial = runOrchestrator([
		"--repository",
		taskPath,
		"--push-remote",
		"origin",
		"--push-ref",
		`refs/heads/${mainBranch}`,
	]);

	const runRoot = path.join(env.runDir, "runs", "git-commits-push-tl");
	const runIds = fs.existsSync(runRoot) ? fs.readdirSync(runRoot) : [];
	runId = runIds[0] ?? "";
	if (!runId) return;
	runDirectory = path.join(runRoot, runId);
	const stateBefore = readPersistedState(runDirectory);
	persistedStateText = fs.readFileSync(
		path.join(runDirectory, "state.json"),
		"utf-8",
	);
	scopeBefore = stateBefore.data.invocationScope;
	repoId = Object.keys(stateBefore.data.repos)[0] ?? "";
	if (!repoId) return;
	frozenTargetBefore =
		stateBefore.data.repos[repoId]?.explicitPushTargetSnapshot;

	const delegationPath = path.join(
		runDirectory,
		"delegations",
		"commit-jobs-0.json",
	);
	const delegation = JSON.parse(fs.readFileSync(delegationPath, "utf-8")) as {
		jobs: Array<{ prompt: string }>;
	};
	delegatedPrompts = delegation.jobs.map((job) => job.prompt);

	const llmResult: CommitJobResultSuccess = {
		success: true,
		id: repoId,
		commits: [
			{
				commit: {
					type: "feat",
					scope: "targeted",
					description: "publish detached task change",
					isBreaking: false,
				},
				files: ["task-change.ts"],
			},
		],
	};
	env.writeLLMResult(repoId, llmResult, runId);

	// Resume WITHOUT targeted flags: durable state supplies scope and target.
	resumed = runOrchestrator(["--resume", "--run-id", runId]);

	const stateAfter = readPersistedState(runDirectory);
	scopeAfter = stateAfter.data.invocationScope;
	frozenTargetAfter = stateAfter.data.repos[repoId]?.explicitPushTargetSnapshot;
	taskHeadAfter = git(taskPath, ["rev-parse", "HEAD"]);
});

after(() => {
	persistent.dispose();
	unrelated.dispose();
	env.dispose();
	fs.rmSync(searchRoot, { recursive: true, force: true });
	fs.rmSync(remoteRoot, { recursive: true, force: true });
});

describe("A7 — detached-HEAD targeted publication", () => {
	test("A7-01 | the initial targeted invocation exits 0 and delegates", () => {
		assert.strictEqual(initial.status, 0);
		assert.ok(initial.stdout.includes("action: DELEGATE"));
	});

	test("A7-02 | only the targeted worktree is discovered and delegated", () => {
		assert.strictEqual(delegatedPrompts.length, 1);
		const payload = JSON.parse(delegatedPrompts[0] ?? "{}") as {
			repository?: string;
		};
		assert.strictEqual(payload.repository, taskPath);
		assert.strictEqual(
			delegatedPrompts.some((prompt) => prompt.includes(unrelated.dir)),
			false,
		);
	});

	test("A7-03 | durable state carries the canonical scope and frozen target", () => {
		const state = readPersistedState(runDirectory);
		assert.deepStrictEqual(scopeBefore, {
			kind: "targeted",
			repository: taskPath,
			pushRemote: "origin",
			pushRef: `refs/heads/${mainBranch}`,
		});
		assert.deepStrictEqual(Object.keys(state.data.repos), [repoId]);
		const repoState = state.data.repos[repoId];
		assert.strictEqual(repoState?.repository, taskPath);
		assert.strictEqual(repoState?.operation, "commit-and-push");
		const frozen = frozenTargetBefore as
			| {
					remote?: string;
					destinationRef?: string;
					destinationBaselineSha?: string;
					pushUrlFingerprint?: string;
			  }
			| undefined;
		assert.strictEqual(frozen?.remote, "origin");
		assert.strictEqual(frozen?.destinationRef, `refs/heads/${mainBranch}`);
		assert.strictEqual(frozen?.destinationBaselineSha, baseline);
		assert.match(frozen?.pushUrlFingerprint ?? "", /^[a-f0-9]{64}$/u);
	});

	test("A7-04 | persisted state never contains the raw push URL", () => {
		assert.ok(!persistedStateText.includes("https://"));
		assert.ok(!persistedStateText.includes(remotePath));
	});

	test("A7-05 | the resume without targeted flags exits 0", () => {
		assert.strictEqual(resumed.status, 0);
		assert.ok(resumed.stdout.includes("action: DONE"));
		assert.ok(resumed.stderr.includes("=== TURNLOCK EXECUTION REPORT ==="));
	});

	test("A7-06 | the remote destination equals the exact task HEAD", () => {
		assert.strictEqual(
			git(remotePath, ["rev-parse", `refs/heads/${mainBranch}`]),
			taskHeadAfter,
		);
		assert.notStrictEqual(taskHeadAfter, baseline);
	});

	test("A7-07 | the task worktree stays detached with the planned commit", () => {
		assert.throws(() => git(taskPath, ["symbolic-ref", "--quiet", "HEAD"]));
		assert.match(
			git(taskPath, ["log", "--oneline", "-1"]),
			/feat\(targeted\): publish detached task change/u,
		);
	});

	test("A7-08 | explicit publication reports no tracking projection", () => {
		// Turnlock persists state at delegation points only, so the terminal
		// outcome is observed through the execution report and the live refs.
		assert.match(
			resumed.stderr,
			new RegExp(
				`Exact remote publication verified: ${taskHeadAfter.slice(0, 7)}`,
			),
		);
		assert.match(
			resumed.stderr,
			/Local remote-tracking ref not changed: no unambiguous matching projection/u,
		);
		assert.ok(
			!resumed.stderr.includes("Local remote-tracking ref synchronized"),
		);
		assert.strictEqual(
			git(taskPath, ["rev-parse", `refs/remotes/origin/${mainBranch}`]),
			baseline,
		);
	});

	test("A7-09 | the persistent checkout is byte-identical", () => {
		assert.deepStrictEqual(captureCheckoutState(persistent), persistentBefore);
		assert.strictEqual(
			git(persistent.dir, ["rev-parse", `refs/heads/${mainBranch}`]),
			baseline,
		);
		assert.strictEqual(
			fs.readFileSync(path.join(persistent.dir, "persistent-wip.ts"), "utf-8"),
			"export const pending = true;\n",
		);
	});

	test("A7-10 | the unrelated repository is untouched", () => {
		assert.deepStrictEqual(captureCheckoutState(unrelated), unrelatedBefore);
	});

	test("A7-11 | durable scope and frozen target are unchanged by the resume", () => {
		assert.deepStrictEqual(scopeAfter, scopeBefore);
		assert.deepStrictEqual(frozenTargetAfter, frozenTargetBefore);
	});
});
