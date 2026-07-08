// NIB-T — Test I5: Test Environment Safety (DC-TEST-SAFETY)
// Given: any test file that spawns the turnlock orchestrator.
// Expected: it must always inject the mocked environment via ...env.env() to prevent state leaks.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

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
		const testsDir = path.resolve(import.meta.dir, "../");
		const testFiles = findTestFiles(testsDir);
		let violations = 0;
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
				const isOrchestratorSpawn = /spawnSync\s*\([^,]+,\s*\[[^\]]*(SKILL_ENTRYPOINT|turnlock-orchestrator\.ts)/.test(chunk);
				
				if (isOrchestratorSpawn) {
					if (!chunk.includes("...env.env()")) {
						violations++;
						violationDetails.push(`${path.basename(file)}: Missing ...env.env() in spawnSync call for orchestrator`);
					}
				}
				
				index = content.indexOf("spawnSync", index + 1);
			}
		}

		expect(violationDetails).toEqual([]);
	});
});
