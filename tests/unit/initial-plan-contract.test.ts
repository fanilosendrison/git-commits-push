import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { handleTurnlockDelegation } from "../../src/entrypoints/turnlock-to-llm-bridge.ts";
import { parseCommitJobResponse } from "../../src/modules/core/commit-job-response.ts";
import type { CommitPlanningPayload } from "../../src/types.ts";
import { syntheticContextAuthority } from "../helpers/context-authority.ts";

const prompt = readFileSync(
	new URL("../../system-prompt.md", import.meta.url),
	"utf8",
);
const captured = readFileSync(
	new URL("../fixtures/initial-plan-missing-description.txt", import.meta.url),
	"utf8",
);
const payload: CommitPlanningPayload = {
	repository: "/synthetic",
	diffHash: "synthetic",
	provider: "google",
	model: "synthetic",
	temperature: 0,
	systemPrompt: prompt,
	diff: "synthetic diff",
};
const valid = ["one.ts", "two.ts", "three.ts", "four.ts"].map(
	(file, index) => ({
		commit: {
			type: "test",
			description: `verify synthetic case ${index}`,
			isBreaking: false,
		},
		files: [file],
	}),
);
const missing = valid.map(({ commit, files }) => ({
	commit: {
		type: commit.type,
		body: "Body is not a subject",
		isBreaking: false,
	},
	files,
}));

async function bridge(responses: readonly string[]) {
	const directory = mkdtempSync(path.join(tmpdir(), "initial-plan-contract-"));
	try {
		const resultPath = path.join(directory, "result.json");
		const manifestPath = path.join(directory, "manifest.json");
		const now = Date.now();
		writeFileSync(
			manifestPath,
			JSON.stringify({
				manifestVersion: 2,
				runId: "synthetic",
				orchestratorName: "git-commits-push-tl",
				phase: "commit-and-push",
				resumeAt: "commit-and-push",
				label: "commit-jobs",
				kind: "batch",
				emittedAt: new Date(now).toISOString(),
				emittedAtEpochMs: now,
				timeoutMs: 600000,
				deadlineAtEpochMs: now + 600000,
				attempt: 0,
				maxAttempts: 1,
				worker: "git-commit-generator",
				jobs: [
					{ id: "synthetic", prompt: JSON.stringify(payload), resultPath },
				],
			}),
		);
		let calls = 0;
		await handleTurnlockDelegation(manifestPath, "synthetic resume", () => "", {
			contextAuthority: syntheticContextAuthority(),
			resolveAuthToken: async () => "mock-token",
			invokeLlm: async (request) => {
				assert.equal(request.systemPrompt, prompt);
				const response = responses[calls++];
				assert.notEqual(
					response,
					undefined,
					"inference exceeded the supplied budget",
				);
				return response as string;
			},
		});
		return { calls, result: JSON.parse(readFileSync(resultPath, "utf8")) };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("planning contract explicitly requires description independently of body", () => {
	assert.match(
		prompt,
		/Each `commit` MUST contain `type` \(a string\) and `description` \(a string\)/u,
	);
	assert.match(
		prompt,
		/`body` explains why; it NEVER replaces\s+`description`/u,
	);
	const examples = prompt.match(/```\n(\[[\s\S]*?\])\n```/u)?.[1];
	assert.ok(examples);
	assert.equal(parseCommitJobResponse(payload, examples).length, 2);
});

test("planning contract treats literal partition membership as authority, not patch escaping", () => {
	assert.match(prompt, /AUTHORITATIVE_PARTITION/u);
	assert.match(prompt, /Do not copy quoted or escaped patch-header paths/u);
	assert.match(prompt, /never add companions outside that membership/u);
	assert.match(prompt, /### Message-only repair/u);
	assert.match(
		prompt,
		/Every repaired commit still requires its own `description`/u,
	);
	assert.match(prompt, /The frozen original candidate retains file ownership/u);
});

test("captured current-provider omission remains refused, never reconstructed", () => {
	assert.equal(
		createHash("sha256").update(captured).digest("hex"),
		"afe54991b4317419c78bf623d2034fb58443e1c2c185fc81445a740e27e83c33",
	);
	assert.throws(
		() => parseCommitJobResponse(payload, captured),
		/description/u,
	);
});

test("one or every missing description in a multi-plan response refuses", () => {
	for (const response of [
		[valid[0], missing[1], valid[2], valid[3]],
		missing,
	]) {
		assert.throws(
			() => parseCommitJobResponse(payload, JSON.stringify(response)),
			/description/u,
		);
	}
	assert.deepEqual(
		parseCommitJobResponse(payload, JSON.stringify(valid)),
		valid,
	);
});

test("persistent omissions and malformed provider output exhaust exactly two local attempts", async () => {
	for (const response of [captured, JSON.stringify(missing), "not JSON"]) {
		const outcome = await bridge([response, response]);
		assert.equal(outcome.calls, 2);
		assert.equal(outcome.result.success, false);
		assert.equal(outcome.result.commits, undefined);
		assert.equal(outcome.result.providerFailureKind, undefined);
	}
});

test("complete initial and authorized second responses preserve all paths and message fields", async () => {
	for (const responses of [
		[JSON.stringify(valid)],
		[JSON.stringify(missing), JSON.stringify(valid)],
	]) {
		const outcome = await bridge(responses);
		assert.equal(outcome.calls, responses.length);
		assert.equal(outcome.result.success, true);
		assert.deepEqual(outcome.result.commits, valid);
	}
});
