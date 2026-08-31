// NIB-T — Test I4: Turnlock stdout Compliance (DC-TURNLOCK)
// Given: any full execution of the orchestrator.
// Expected: stdout contains ONLY valid @@TURNLOCK@@ protocol blocks — no other bytes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { GitRepoFixture } from "../fixtures/git-repo.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";

let repoDirty: GitRepoFixture;
let env: MockTurnlockEnvironment;
let searchRoot: string;

const SKILL_ENTRYPOINT = path.resolve(
	import.meta.dirname,
	"../../src/entrypoints/turnlock-orchestrator.ts",
);

beforeEach(() => {
	env = MockTurnlockEnvironment.create();
	searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "i4-"));
	repoDirty = GitRepoFixture.create({ parentDir: searchRoot });
	repoDirty.commit("initial commit");
	repoDirty.writeAndStage("stdout-test.ts", "export const x = 'stdout';\n");

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

afterEach(() => {
	repoDirty.dispose();
	env.dispose();
	fs.rmSync(searchRoot, { recursive: true, force: true });
});

/**
 * Parses raw stdout and extracts everything OUTSIDE of @@TURNLOCK@@ blocks.
 * Any non-whitespace content outside a block is a violation.
 */
function extractNonProtocolBytes(stdout: string): string {
	// Remove all content between @@TURNLOCK@@ ... @@END@@ (inclusive)
	const withoutBlocks = stdout.replace(/@@TURNLOCK@@[\s\S]*?@@END@@/g, "");
	// What remains must only be whitespace
	return withoutBlocks.replace(/\s/g, "");
}

describe("I4 — Turnlock stdout Compliance", () => {
	test("I4-01 | initial run: stdout contains zero bytes outside protocol blocks", () => {
		const result = spawnSync(process.execPath, [SKILL_ENTRYPOINT], {
			env: {
				...process.env,
				...env.env(),
				TURNLOCK_RUN_DIR_ROOT: path.join(env.runDir, "runs-i4-initial"),
			},
			encoding: "utf-8",
		});
		const stdout = result.stdout ?? "";
		const pollution = extractNonProtocolBytes(stdout);
		assert.strictEqual(pollution, "");
	});

	test("I4-02 | initial run: Phase 5 report is on stderr, not stdout", () => {
		const result = spawnSync(process.execPath, [SKILL_ENTRYPOINT], {
			env: {
				...process.env,
				...env.env(),
				TURNLOCK_RUN_DIR_ROOT: path.join(env.runDir, "runs-i4-stderr"),
			},
			encoding: "utf-8",
		});
		const stdout = result.stdout ?? "";
		// The execution report must NOT appear in stdout
		assert.ok(!stdout.includes("=== TURNLOCK EXECUTION REPORT ==="));
		assert.ok(!stdout.includes("✅"));
		assert.ok(!stdout.includes("❌"));
	});

	test("I4-03 | initial run: no console.log / debug traces in stdout", () => {
		const result = spawnSync(process.execPath, [SKILL_ENTRYPOINT], {
			env: {
				...process.env,
				...env.env(),
				TURNLOCK_RUN_DIR_ROOT: path.join(env.runDir, "runs-i4-debug"),
			},
			encoding: "utf-8",
		});
		const stdout = result.stdout ?? "";
		// Common debug artifacts that must not appear in stdout
		assert.ok(!stdout.includes("[DEBUG]"));
		assert.ok(!stdout.includes("[INFO]"));
		assert.ok(!stdout.includes("[ERROR]"));
		assert.ok(!stdout.includes("console.log"));
		// Any line that is not a @@ marker is a violation
		const pollution = extractNonProtocolBytes(stdout);
		assert.strictEqual(pollution, "");
	});
});
