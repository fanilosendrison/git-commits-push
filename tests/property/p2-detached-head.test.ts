// NIB-T — Test P2: Detached HEAD ordinary invocation (Phase 1)
// Given: the current invocation worktree is on a detached HEAD and an unrelated
// dirty repository exists under the historical search root.
// Expected: ordinary invocation fails closed with explicit-publication guidance;
// it never searches another repository or silently reports success.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";

let repoDetached: GitRepoFixture;
let unrelatedDirty: GitRepoFixture;
let env: MockTurnlockEnvironment;
let searchRoot: string;

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dirname,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

before(() => {
	env = MockTurnlockEnvironment.create();
	searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p2-"));

	// repo-detached: a commit, detached HEAD, then a staged change.
	repoDetached = GitRepoFixture.create({ parentDir: searchRoot });
	repoDetached.commit("initial commit");
	repoDetached.checkoutDetached();
	repoDetached.writeAndStage("extra.ts", "export const y = 2;\n");

	// unrelated dirty repository under the same historical search root.
	unrelatedDirty = GitRepoFixture.create({ parentDir: searchRoot });
	unrelatedDirty.commit("initial commit");
	unrelatedDirty.writeAndStage("unrelated.ts", "export const z = 3;\n");

	env.writeSettings({
		searchPaths: [searchRoot],
		provider: "anthropic",
		model: "claude-3-5-sonnet-20241022",
		temperature: 0,
		systemPromptPath: "/nonexistent",
		autoPush: false,
		skipTests: true,
	});
});

after(() => {
	repoDetached.dispose();
	unrelatedDirty.dispose();
	env.dispose();
	fs.rmSync(searchRoot, { recursive: true, force: true });
});

describe("P2 — Detached HEAD ordinary invocation", () => {
	let stdout: string;
	let stderr: string;
	let exitCode: number;

	test("P2-01 | the process fails closed (non-zero exit)", () => {
		const result = spawnSync(process.execPath, [SKILL_ENTRYPOINT], {
			env: {
				...process.env,
				...env.env(),
				GCP_INVOCATION_CWD: repoDetached.dir,
			},
			encoding: "utf-8",
		});
		stdout = result.stdout ?? "";
		stderr = result.stderr ?? "";
		exitCode = result.status ?? 0;
		assert.notStrictEqual(exitCode, 0, `stdout=${stdout}\nstderr=${stderr}`);
	});

	test("P2-02 | no delegation is emitted", () => {
		assert.ok(!stdout.includes("action: DELEGATE"));
		assert.ok(!stdout.includes("@@TURNLOCK@@"));
	});

	test("P2-03 | stderr names detached HEAD and the missing publication authority", () => {
		assert.match(stderr, /detached HEAD/);
		assert.match(stderr, /no implicit publication destination/);
		assert.match(stderr, /--repository/);
		assert.match(stderr, /--push-remote/);
		assert.match(stderr, /--push-ref/);
	});

	test("P2-04 | no other repository is searched", () => {
		assert.ok(!stdout.includes(unrelatedDirty.dir));
		assert.ok(!stderr.includes(`Validating repo: ${unrelatedDirty.dir}`));
		assert.ok(!stderr.includes(unrelatedDirty.dir));
	});
});
