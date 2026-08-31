// NIB-T — Test A1: End-to-End Initial Run (Phases 1, 2, 3)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";

let repoClean: GitRepoFixture;
let repoDirty: GitRepoFixture;
let env: MockTurnlockEnvironment;
let searchRoot: string;

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dirname,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

before(() => {
	env = MockTurnlockEnvironment.create();
	searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "a1-"));

	// repo-clean: initialized with a commit, no staged changes
	repoClean = GitRepoFixture.create({ parentDir: searchRoot });
	repoClean.commit("initial commit");

	// repo-dirty: initialized with a commit, then staged changes
	repoDirty = GitRepoFixture.create({ parentDir: searchRoot });
	repoDirty.commit("initial commit");
	repoDirty.writeAndStage("hello.ts", "export const hello = 'world';\n");

	env.writeSettings({
		searchPaths: [searchRoot],
		provider: "anthropic",
		model: "claude-3-5-sonnet-20241022",
		temperature: 0,
		systemPromptPath: path.join(import.meta.dirname, "../../system-prompt.md"),
		autoPush: false,
		skipTests: true,
	});
});

after(() => {
	repoClean.dispose();
	repoDirty.dispose();
	env.dispose();
	fs.rmSync(searchRoot, { recursive: true, force: true });
});

describe("A1 — End-to-End Initial Run", () => {
	let stdout: string;
	let exitCode: number;

	test("A1-01 | skill process exits with code 0", () => {
		const result = spawnSync(process.execPath, [SKILL_ENTRYPOINT], {
			env: {
				...process.env,
				...env.env(),
			},
			encoding: "utf-8",
		});
		stdout = result.stdout ?? "";
		exitCode = result.status ?? -1;
		assert.strictEqual(exitCode, 0);
	});

	test("A1-02 | stdout contains exactly one @@TURNLOCK@@ block", () => {
		const matches = stdout.match(/@@TURNLOCK@@/g);
		assert.notStrictEqual(matches, null);
		assert.strictEqual(matches?.length, 1); // one opening marker
	});

	test("A1-03 | delegation uses the Turnlock v2 batch protocol", () => {
		assert.ok(stdout.includes("version: 2"));
		assert.ok(stdout.includes("kind: batch"));
	});

	test("A1-05 | repo-clean is NOT included in the delegation", () => {
		// The clean repo path should not appear in the stdout protocol block
		assert.ok(!stdout.includes(repoClean.dir));
	});

	test("A1-06 | state.json is written to runDir", () => {
		// Turnlock writes state.json in the runDir it manages
		// We check that any state.json exists under the runs directory
		const runsDir = path.join(env.runDir, "runs");
		const stateFiles: string[] = [];

		function findState(dir: string): void {
			if (!fs.existsSync(dir)) return;
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) findState(full);
				if (entry.name === "state.json") stateFiles.push(full);
			}
		}

		findState(runsDir);
		assert.ok(stateFiles.length > 0);
		const firstStateFile = stateFiles[0];
		assert.notStrictEqual(firstStateFile, undefined);
		if (!firstStateFile) return;
		const state = JSON.parse(fs.readFileSync(firstStateFile, "utf-8")) as {
			schemaVersion: number;
			currentPhase: string;
			pendingDelegation?: { kind: string; jobIds?: string[] };
		};
		assert.strictEqual(state.schemaVersion, 2);
		assert.strictEqual(state.currentPhase, "discovery-and-validation");
		assert.strictEqual(state.pendingDelegation?.kind, "batch");
		assert.ok((state.pendingDelegation?.jobIds?.length ?? 0) > 0);
	});

	test("A1-07 | delegation manifest contains prompt with diff payload", () => {
		// Find any manifest file written under delegations/
		const runsDir = path.join(env.runDir, "runs");
		let manifest: unknown = null;

		function findManifest(dir: string): void {
			if (!fs.existsSync(dir)) return;
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) findManifest(full);
				if (
					entry.name.startsWith("commit-jobs") &&
					entry.name.endsWith(".json")
				) {
					manifest = JSON.parse(fs.readFileSync(full, "utf-8"));
				}
			}
		}

		findManifest(runsDir);
		assert.notStrictEqual(manifest, null);
		const m = manifest as {
			manifestVersion: number;
			orchestratorName: string;
			phase: string;
			resumeAt: string;
			kind: string;
			worker?: string;
			maxAttempts: number;
			jobs: { id: string; prompt: string; resultPath: string }[];
		};
		assert.strictEqual(m.manifestVersion, 2);
		assert.strictEqual(m.orchestratorName, "git-commits-push-tl");
		assert.strictEqual(m.phase, "discovery-and-validation");
		assert.strictEqual(m.resumeAt, "commit-and-push");
		assert.strictEqual(m.kind, "batch");
		assert.strictEqual(m.worker, "git-commit-generator");
		assert.strictEqual(m.maxAttempts, 1);
		assert.ok(m.jobs.length > 0);

		// The prompt must be a valid JSON-serialized CommitJobPayload
		const firstJob = m.jobs[0];
		assert.notStrictEqual(firstJob, undefined);
		if (!firstJob) return;
		const payload = JSON.parse(firstJob.prompt);
		assert.ok(Object.hasOwn(payload, "diff"));
		assert.ok(Object.hasOwn(payload, "diffHash"));
	});
});
