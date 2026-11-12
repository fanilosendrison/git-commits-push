import assert from "node:assert/strict";
import { test } from "node:test";
import { handleLlmJobFailure } from "../../src/modules/core/llm-job-failure-handler.ts";
import { retryJobs } from "../../src/modules/core/queue-retry.ts";
import { createSkillStatsLog } from "../../src/modules/telemetry/stats-logger.ts";
import {
	fixture,
	fixtureBridge,
	git,
	settings,
	transport,
} from "../fixtures/context-planning.ts";

for (const fingerprint of [undefined, "genuine-complete-plan"]) {
	test(`fatal malformed diagnostic cannot acquire recovery authority (${fingerprint ?? "absent"})`, async () => {
		const f = await fixture();
		try {
			retryJobs.length = 0;
			let calls = 0;
			const index = git(f.repo.dir, "write-tree");
			const dependencies = {
				...transport(f),
				invoke: async () => {
					calls++;
					return "validation rejected";
				},
			};
			const failed = await fixtureBridge(f, dependencies);
			assert.equal(failed.success, false);
			if (failed.success) throw new Error("Expected malformed output failure");
			assert.match(failed.error, /^LLM Fatal Error:/u);
			assert.match(failed.error, /validation rejected/u);
			assert.equal(calls, 2);
			const attempts = { validation: 1, structural: 0, provider: 0 };
			const next = handleLlmJobFailure({
				result: failed,
				repoState: {
					repository: f.repo.dir,
					status: "RUNNING",
					validatedSource: f.validated.validatedSource,
					diffHash: f.validated.diffHash,
					lastPlanHash: fingerprint,
					attempts,
				},
				runId: "synthetic-terminal",
				settings: {
					...settings,
					fallbackProvider: "mistral",
					fallbackModel: "synthetic-fallback",
				},
				systemPrompt: "test",
				skillLog: createSkillStatsLog(),
			});
			assert.equal(next.status, "FAILED");
			assert.equal(retryJobs.length, 0);
			assert.deepEqual(next.attempts, attempts);
			assert.equal(next.lastPlanHash, fingerprint);
			assert.equal(next.fallbackAttempted, undefined);
			assert.equal(git(f.repo.dir, "write-tree"), index);
			assert.equal(git(f.repo.dir, "rev-parse", "HEAD"), f.head);
			assert.equal(git(f.remote, "rev-parse", "HEAD"), f.head);
		} finally {
			retryJobs.length = 0;
			f.dispose();
		}
	});
}
