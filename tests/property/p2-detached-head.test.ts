// NIB-T — Test P2: Detached HEAD Exclusion (Phase 1)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";

let repoDetached: GitRepoFixture;
let env: MockTurnlockEnvironment;

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dir,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

beforeAll(() => {
	env = MockTurnlockEnvironment.create();

	// Create a repo with a commit, then put it in detached HEAD, then stage changes
	repoDetached = GitRepoFixture.create();
	repoDetached.commit("initial commit");
	repoDetached.checkoutDetached();
	// Stage a change even in detached HEAD
	repoDetached.writeAndStage("extra.ts", "export const y = 2;\n");

	env.writeSettings({
		searchPaths: [path.dirname(repoDetached.dir)],
		provider: "anthropic",
		model: "claude-3-5-sonnet-20241022",
		temperature: 0,
		systemPromptPath: "/nonexistent",
		autoPush: false,
		skipTests: true,
	});
});

afterAll(() => {
	repoDetached.dispose();
	env.dispose();
});

describe("P2 — Detached HEAD Exclusion", () => {
	let stdout: string;
	let exitCode: number;

	test("P2-01 | skill process exits with code 0", () => {
		const result = spawnSync("bun", ["run", SKILL_ENTRYPOINT], {
			env: {
				...process.env,
				TURNLOCK_RUN_DIR_ROOT: path.join(env.runDir, "runs"),
				TURNLOCK_SKILL_SETTINGS_PATH: path.join(env.runDir, "settings.json"),
			},
			encoding: "utf-8",
		});
		stdout = result.stdout ?? "";
		exitCode = result.status ?? -1;
		expect(exitCode).toBe(0);
	});

	test("P2-02 | no @@TURNLOCK@@ DELEGATE block is emitted (nothing to delegate)", () => {
		// If no valid repo is found, the orchestrator should call io.done() directly
		// rather than producing a delegation block
		expect(stdout).not.toContain("action: DELEGATE");
	});

	test("P2-03 | detached repo path is not present in any delegation job", () => {
		expect(stdout).not.toContain(repoDetached.dir);
	});
});
