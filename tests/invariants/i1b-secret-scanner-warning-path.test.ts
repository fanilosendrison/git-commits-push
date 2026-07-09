// NIB-T — Test I1b: Secret Scanner Warning Path
// Given: a repo with a secret in a non-production path (tests/).
// Expected: that repo is NOT blocked (included in delegation), a warning event
// is logged, and no block event is emitted.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";

let repoWarning: GitRepoFixture;
let env: MockTurnlockEnvironment;
let searchRoot: string;

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dir,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

beforeAll(() => {
	env = MockTurnlockEnvironment.create();
	searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "i1b-"));

	// repo-warning: secret staged inside a tests/ directory (non-production path)
	repoWarning = GitRepoFixture.create({ parentDir: searchRoot });
	repoWarning.commit("initial commit");
	fs.mkdirSync(path.join(repoWarning.dir, "tests"));
	repoWarning.writeAndStage(
		"tests/config.test.ts",
		`export const mockKey = "AKIAIOSFODNN7EXAMPLE";\n`,
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
	repoWarning.dispose();
	env.dispose();
	fs.rmSync(searchRoot, { recursive: true, force: true });
});

describe("I1b — Secret Scanner Warning Path", () => {
	let exitCode: number;

	test("I1b-01 | process exits with code 0", () => {
		const result = spawnSync("bun", ["run", SKILL_ENTRYPOINT], {
			env: {
				...process.env,
				...env.env(),
			},
			encoding: "utf-8",
		});
		exitCode = result.status ?? -1;
		expect(exitCode).toBe(0);
	});

	test("I1b-02 | delegation manifest contains repo-warning (not blocked)", () => {
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

		// repo-warning MUST be present — the secret was in tests/, so it's a warning not a block
		expect(paths.some((p: string) => p === repoWarning.dir)).toBe(true);
	});

	test("I1b-03 | a warning event is logged to secret-scanner stats", () => {
		// The secret-scanner sink writes to <statsDir>/events.jsonl.
		// Both PI_SKILL_STATS_DIR and SECRET_SCANNER_STATS_DIR point to the same
		// statsDir via env(), so the file may contain mixed event types.
		const eventsPath = path.join(env.statsDir, "events.jsonl");
		expect(fs.existsSync(eventsPath)).toBe(true);
		const events = fs
			.readFileSync(eventsPath, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		const warningEvents = events.filter(
			(e: { eventType: string }) => e.eventType === "warning",
		);
		expect(warningEvents.length).toBeGreaterThanOrEqual(1);
		expect(warningEvents[0].namespace).toBe("secret-scanner");
		expect(warningEvents[0].details.findingsCount).toBeGreaterThanOrEqual(1);
	});

	test("I1b-04 | no block event is logged for this repo", () => {
		const eventsPath = path.join(env.statsDir, "events.jsonl");
		if (!fs.existsSync(eventsPath)) return;
		const events = fs
			.readFileSync(eventsPath, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		const blockEvents = events.filter(
			(e: { eventType: string }) => e.eventType === "block",
		);
		expect(blockEvents).toHaveLength(0);
	});
});
