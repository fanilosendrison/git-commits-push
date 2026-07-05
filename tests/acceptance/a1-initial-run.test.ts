// NIB-T — Test A1: End-to-End Initial Run (Phases 1, 2, 3)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";

let repoClean: GitRepoFixture;
let repoDirty: GitRepoFixture;
let env: MockTurnlockEnvironment;
let searchRoot: string;

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dir,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

beforeAll(() => {
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
		systemPromptPath: path.join(import.meta.dir, "../../system-prompt.md"),
		autoPush: false,
		skipTests: true,
	});
});

afterAll(() => {
	repoClean.dispose();
	repoDirty.dispose();
	env.dispose();
	fs.rmSync(searchRoot, { recursive: true, force: true });
});

describe("A1 — End-to-End Initial Run", () => {
	let stdout: string;
	let exitCode: number;

	test("A1-01 | skill process exits with code 0", () => {
		const result = spawnSync("bun", ["run", SKILL_ENTRYPOINT], {
			env: {
				...process.env,
				...env.env(),
			},
			encoding: "utf-8",
		});
		stdout = result.stdout ?? "";
		exitCode = result.status ?? -1;
		expect(exitCode).toBe(0);
	});

	test("A1-02 | stdout contains exactly one @@TURNLOCK@@ block", () => {
		const matches = stdout.match(/@@TURNLOCK@@/g);
		expect(matches).not.toBeNull();
		expect(matches?.length).toBe(1); // one opening marker
	});

	test("A1-03 | delegation kind is agent-batch", () => {
		expect(stdout).toContain("kind: agent-batch");
	});

	test("A1-05 | repo-clean is NOT included in the delegation", () => {
		// The clean repo path should not appear in the stdout protocol block
		expect(stdout).not.toContain(repoClean.dir);
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
		expect(stateFiles.length).toBeGreaterThan(0);
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
		expect(manifest).not.toBeNull();
		const m = manifest as {
			kind: string;
			jobs: { id: string; prompt: string }[];
		};
		expect(m.kind).toBe("agent-batch");
		expect(m.jobs.length).toBeGreaterThan(0);

		// The prompt must be a valid JSON-serialized CommitJobPayload
		const firstJob = m.jobs[0];
		expect(firstJob).toBeDefined();
		if (!firstJob) return;
		const payload = JSON.parse(firstJob.prompt);
		expect(payload).toHaveProperty("diff");
		expect(payload).toHaveProperty("diffHash");
	});
});
