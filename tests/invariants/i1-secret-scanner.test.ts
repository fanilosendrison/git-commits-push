// NIB-T — Test I1: Secret Scanner Fail-Closed (DC-SECRET-SCANNER)
// Given: the current invocation worktree has a secret in its staged diff, and an
// unrelated dirty repository exists under the historical search root.
// Expected: the secret worktree fails closed; the unrelated repository is never
// discovered, delegated, or mutated.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";
import { captureRepositoryState } from "../helpers/test-helpers.ts";

let repoClean: GitRepoFixture;
let repoWithSecret: GitRepoFixture;
let env: MockTurnlockEnvironment;
let searchRoot: string;
let cleanRepositoryStateBefore: string;
let secretHeadBefore: string;

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dirname,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

before(() => {
	env = MockTurnlockEnvironment.create();
	searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "i1-"));

	// repo-clean: unrelated dirty repository under the same historical search root.
	repoClean = GitRepoFixture.create({ parentDir: searchRoot });
	repoClean.commit("initial commit");
	repoClean.writeAndStage("clean.ts", "export const ok = true;\n");

	// repo-with-secret: the current invocation worktree, staged change containing
	// a mock AWS secret.
	repoWithSecret = GitRepoFixture.create({ parentDir: searchRoot });
	repoWithSecret.commit("initial commit");
	repoWithSecret.writeAndStage(
		"config.ts",
		`export const key = "AKIAIOSFODNN7EXAMPLE";\n`,
	);

	env.writeSettings({
		searchPaths: [searchRoot],
		provider: "anthropic",
		model: "claude-3-5-sonnet-20241022",
		temperature: 0,
		systemPromptPath: path.join(import.meta.dirname, "../../system-prompt.md"),
		autoPush: false,
		skipTests: true,
	});

	cleanRepositoryStateBefore = captureRepositoryState(repoClean.dir);
	secretHeadBefore = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: repoWithSecret.dir,
		encoding: "utf-8",
	}).stdout.trim();
});

after(() => {
	repoClean.dispose();
	repoWithSecret.dispose();
	env.dispose();
	fs.rmSync(searchRoot, { recursive: true, force: true });
});

describe("I1 — Secret Scanner Fail-Closed", () => {
	let stdout: string;
	let stderr: string;
	let exitCode: number;

	test("I1-01 | the secret-bearing invocation worktree fails closed", () => {
		const result = spawnSync(process.execPath, [SKILL_ENTRYPOINT], {
			env: {
				...process.env,
				...env.env(),
				GCP_INVOCATION_CWD: repoWithSecret.dir,
			},
			encoding: "utf-8",
		});
		stdout = result.stdout ?? "";
		stderr = result.stderr ?? "";
		exitCode = result.status ?? -1;
		// The established fatal behavior reports an ERROR protocol block while
		// the process itself still exits 0; no work is committed or delegated.
		assert.strictEqual(exitCode, 0, `stdout=${stdout}\nstderr=${stderr}`);
		assert.ok(stdout.includes("action: ERROR"));
		assert.ok(!stdout.includes("action: DELEGATE"));
		assert.match(stderr, /Security Exception: Secret detected in diff/);
	});

	test("I1-02 | no delegation is produced for the unrelated repository", () => {
		const runsDir = path.join(env.runDir, "runs");
		const manifests: string[] = [];

		function findManifests(dir: string): void {
			if (!fs.existsSync(dir)) return;
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) findManifests(full);
				if (
					entry.name.startsWith("commit-jobs") &&
					entry.name.endsWith(".json")
				) {
					manifests.push(full);
				}
			}
		}
		findManifests(runsDir);

		assert.deepStrictEqual(manifests, []);
		assert.ok(!stdout.includes(repoClean.dir));
	});

	test("I1-03 | the unrelated repository is byte-for-byte unchanged", () => {
		assert.strictEqual(
			captureRepositoryState(repoClean.dir),
			cleanRepositoryStateBefore,
		);
		// The secret worktree is also never committed by the failing run.
		assert.strictEqual(
			spawnSync("git", ["rev-parse", "HEAD"], {
				cwd: repoWithSecret.dir,
				encoding: "utf-8",
			}).stdout.trim(),
			secretHeadBefore,
		);
	});

	test("I1-04 | no runtime exception is thrown for the unrelated repository", () => {
		const result = spawnSync(process.execPath, [SKILL_ENTRYPOINT], {
			env: {
				...process.env,
				...env.env(),
				GCP_INVOCATION_CWD: repoWithSecret.dir,
				TURNLOCK_RUN_DIR_ROOT: path.join(env.runDir, "runs-i1-04"),
			},
			encoding: "utf-8",
		});
		const resultStderr = result.stderr ?? "";
		assert.ok(!resultStderr.includes("Uncaught"));
		assert.ok(!resultStderr.includes("UnhandledPromiseRejection"));
		// No global fall-through: the unrelated dirty repository never enters a run.
		assert.ok(!resultStderr.includes(`Validating repo: ${repoClean.dir}`));
	});
});
