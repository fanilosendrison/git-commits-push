// NIB-T — Test I3: Ordinary Worktree Isolation
// Given: two dirty linked worktrees A and B of the same repository.
// Expected: an ordinary invocation from A processes only A; B is never
// discovered, delegated, or mutated in its index, HEAD, working tree, branch
// refs, or local configuration.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";
import { captureRepositoryState } from "../helpers/test-helpers.ts";

let primary: GitRepoFixture;
let worktreeA: string;
let worktreeB: string;
let env: MockTurnlockEnvironment;
let searchRoot: string;
let worktreeBStateBefore: string;

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dirname,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", [...args], {
		cwd,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}

before(() => {
	env = MockTurnlockEnvironment.create();
	searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "i3-"));

	primary = GitRepoFixture.create({ parentDir: searchRoot });
	primary.commit("initial commit");
	worktreeA = path.join(searchRoot, "worktree-a");
	worktreeB = path.join(searchRoot, "worktree-b");
	git(primary.dir, ["worktree", "add", worktreeA, "-b", "branch-a"]);
	git(primary.dir, ["worktree", "add", worktreeB, "-b", "branch-b"]);

	fs.writeFileSync(path.join(worktreeA, "a.ts"), "export const a = 1;\n");
	git(worktreeA, ["add", "-A"]);
	fs.writeFileSync(path.join(worktreeB, "b.ts"), "export const b = 2;\n");
	git(worktreeB, ["add", "-A"]);

	env.writeSettings({
		searchPaths: [searchRoot],
		provider: "anthropic",
		model: "claude-3-5-sonnet-20241022",
		temperature: 0,
		systemPromptPath: path.join(import.meta.dirname, "../../system-prompt.md"),
		autoPush: false,
		skipTests: true,
	});

	worktreeBStateBefore = captureRepositoryState(worktreeB);
});

after(() => {
	primary.dispose();
	env.dispose();
	fs.rmSync(searchRoot, { recursive: true, force: true });
});

describe("I3 — Ordinary Worktree Isolation", () => {
	let stdout: string;
	let exitCode: number;

	test("I3-01 | process exits with code 0", () => {
		const result = spawnSync(process.execPath, [SKILL_ENTRYPOINT], {
			env: {
				...process.env,
				...env.env(),
				GCP_INVOCATION_CWD: worktreeA,
			},
			encoding: "utf-8",
		});
		stdout = result.stdout ?? "";
		exitCode = result.status ?? -1;
		assert.strictEqual(exitCode, 0);
	});

	test("I3-02 | a delegation is emitted for the invocation worktree", () => {
		assert.ok(stdout.includes("@@TURNLOCK@@"));
		assert.ok(stdout.includes("action: DELEGATE"));
	});

	test("I3-03 | manifest contains only worktree A and no B file", () => {
		const runsDir = path.join(env.runDir, "runs");
		let manifest: { jobs: { id: string; prompt: string }[] } | null = null;

		function findManifest(dir: string): void {
			if (!fs.existsSync(dir)) return;
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) findManifest(full);
				if (
					entry.name.startsWith("commit-jobs") &&
					entry.name.endsWith(".json")
				) {
					manifest = JSON.parse(fs.readFileSync(full, "utf-8")) as {
						jobs: { id: string; prompt: string }[];
					};
				}
			}
		}
		findManifest(runsDir);
		assert.notStrictEqual(manifest, null);
		const m = manifest as unknown as { jobs: { id: string; prompt: string }[] };
		assert.strictEqual(m.jobs.length, 1);

		for (const job of m.jobs) {
			const payload = JSON.parse(job.prompt) as {
				repository: string;
				diff: string;
			};
			assert.strictEqual(payload.repository, fs.realpathSync(worktreeA));
			assert.ok(!payload.repository.includes(worktreeB));
			assert.ok(!payload.diff.includes("b.ts"));
		}
	});

	test("I3-04 | worktree B is byte-for-byte unchanged", () => {
		assert.strictEqual(captureRepositoryState(worktreeB), worktreeBStateBefore);
	});
});
