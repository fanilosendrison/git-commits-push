// NIB-T — Test I1: Secret Scanner Fail-Closed (DC-SECRET-SCANNER)
// Given: a repo with a secret in staged diff.
// Expected: that repo is marked FAILED; other parallel repos are unaffected.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";

let repoClean: GitRepoFixture;
let repoWithSecret: GitRepoFixture;
let env: MockTurnlockEnvironment;
let searchRoot: string;

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dir,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

beforeAll(() => {
	env = MockTurnlockEnvironment.create();
	searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "i1-"));

	// repo-clean: valid staged change, no secrets
	repoClean = GitRepoFixture.create({ parentDir: searchRoot });
	repoClean.commit("initial commit");
	repoClean.writeAndStage("clean.ts", "export const ok = true;\n");

	// repo-with-secret: staged change containing a mock AWS secret
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
		systemPromptPath: path.join(import.meta.dir, "../../system-prompt.md"),
		autoPush: false,
		skipTests: true,
	});
});

afterAll(() => {
	repoClean.dispose();
	repoWithSecret.dispose();
	env.dispose();
	fs.rmSync(searchRoot, { recursive: true, force: true });
});

describe("I1 — Secret Scanner Fail-Closed", () => {
	let stdout: string;
	let exitCode: number;

	test("I1-01 | process exits with code 0 (partial success is still a valid run)", () => {
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

	test("I1-02 | stdout contains a delegation block (because repo-clean succeeded)", () => {
		expect(stdout).toContain("@@TURNLOCK@@");
		expect(stdout).toContain("action: DELEGATE");
	});

	test("I1-03 | the delegation manifest contains repo-clean but not repo-with-secret", () => {
		// Find the manifest file
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

		expect(manifest).not.toBeNull();
		const m = manifest as unknown as { jobs: { id: string; prompt: string }[] };
		const paths = m.jobs.map(
			(j: { id: string; prompt: string }) =>
				JSON.parse(j.prompt).repository as string,
		);

		// repo-clean must be present
		expect(paths.some((p: string) => p === repoClean.dir)).toBe(true);
		// repo-with-secret must be absent
		expect(paths.some((p: string) => p === repoWithSecret.dir)).toBe(false);
	});

	test("I1-04 | no runtime exception is thrown for the clean repo due to the secret repo failure", () => {
		// The fact that exit code is 0 and a delegation block was emitted is enough,
		// but we also verify stderr contains no unhandled exception traces.
		const result = spawnSync("bun", ["run", SKILL_ENTRYPOINT], {
			env: {
				...process.env,
				TURNLOCK_RUN_DIR_ROOT: path.join(env.runDir, "runs-i1-04"),
				TURNLOCK_SKILL_SETTINGS_PATH: path.join(env.runDir, "settings.json"),
				PI_SKILL_STATS_DIR: env.statsDir,
				SECRET_SCANNER_STATS_DIR: env.statsDir,
			},
			encoding: "utf-8",
		});
		const stderr = result.stderr ?? "";
		expect(stderr).not.toContain("Uncaught");
		expect(stderr).not.toContain("UnhandledPromiseRejection");
	});
});
