// NIB-T — Test I5: Test Environment Safety (DC-TEST-SAFETY)
// Given: any test file that spawns the turnlock orchestrator.
// Expected: it must always inject the mocked environment via ...env.env() to prevent state leaks.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { ORDER_ENV_KEYS } from "../../src/modules/orders/types.ts";
import { MockTurnlockEnvironment } from "../fixtures/mock-turnlock-env.ts";

function findTestFiles(dir: string, fileList: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			findTestFiles(full, fileList);
		} else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
			fileList.push(full);
		}
	}
	return fileList;
}

describe("I5 — Test Environment Safety", () => {
	test("I5-01 | all tests spawning the orchestrator must use MockTurnlockEnvironment (env.env)", () => {
		const testsDir = path.resolve(import.meta.dirname, "../");
		const testFiles = findTestFiles(testsDir);
		let _violations = 0;
		const violationDetails: string[] = [];

		for (const file of testFiles) {
			const content = fs.readFileSync(file, "utf-8");
			if (file.endsWith("git-publisher.test.ts")) continue;

			let index = content.indexOf("spawnSync");
			while (index !== -1) {
				// look at the next 500 characters
				const chunk = content.substring(index, index + 500);

				// check if it's actually an invocation of the orchestrator in this chunk
				// (the definition of SKILL_ENTRYPOINT is usually not within 500 chars of the spawnSync import)
				const isOrchestratorSpawn =
					/spawnSync\s*\([^,]+,\s*\[[^\]]*(SKILL_ENTRYPOINT|turnlock-orchestrator\.ts)/.test(
						chunk,
					);

				if (isOrchestratorSpawn) {
					if (!chunk.includes("...env.env()")) {
						_violations++;
						violationDetails.push(
							`${path.basename(file)}: Missing ...env.env() in spawnSync call for orchestrator`,
						);
					}
				}

				index = content.indexOf("spawnSync", index + 1);
			}
		}

		assert.deepStrictEqual(violationDetails, []);
	});

	test("I5-02 | mocked subprocesses clear inherited agent and order identities", () => {
		const environment = MockTurnlockEnvironment.create();
		try {
			const isolatedEnvironment = environment.env();
			assert.strictEqual(isolatedEnvironment.ANTIGRAVITY_AGENT, undefined);
			assert.strictEqual(
				isolatedEnvironment.ANTIGRAVITY_TRAJECTORY_ID,
				undefined,
			);
			assert.strictEqual(isolatedEnvironment.CODEX_THREAD_ID, undefined);
			assert.strictEqual(isolatedEnvironment.NODE_ENV, "test");
			assert.strictEqual(isolatedEnvironment.PI_SESSION_ID, undefined);
			assert.strictEqual(isolatedEnvironment.PI_SKILL_STATS_MODE, undefined);
			for (const name of Object.values(ORDER_ENV_KEYS)) {
				assert.strictEqual(isolatedEnvironment[name], undefined);
			}
		} finally {
			environment.dispose();
		}
	});
});
