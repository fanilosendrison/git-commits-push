import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseTurnlockBatchManifest } from "../../src/modules/turnlock/batch-manifest.ts";

const job = {
	id: "repo-1",
	prompt: "{}",
	resultPath: "/tmp/result.json",
};
const base = {
	runId: "run-123",
	orchestratorName: "git-commits-push-tl",
	phase: "discovery-and-validation",
	resumeAt: "commit-and-push",
	label: "commit-jobs",
	kind: "batch",
	emittedAt: "2026-01-01T00:00:00.000Z",
	emittedAtEpochMs: 1_768_000_000_000,
	timeoutMs: 600_000,
	deadlineAtEpochMs: 1_768_000_600_000,
	attempt: 0,
	maxAttempts: 1,
	jobs: [job],
} as const;

function parse(manifest: object) {
	return parseTurnlockBatchManifest(JSON.stringify(manifest));
}

describe("Turnlock batch manifest authorization", () => {
	test("accepts newly-authored v3 for the authorized logical worker", () => {
		const manifest = parse({
			...base,
			manifestVersion: 3,
			target: { kind: "worker", name: "git-commit-generator" },
		});
		assert.strictEqual(manifest.manifestVersion, 3);
	});

	test("accepts a migrated v3 with the closed compatibility marker", () => {
		const manifest = parse({
			...base,
			manifestVersion: 3,
			target: { kind: "worker", name: "git-commit-generator" },
			targetCompatibility: "legacy-v2",
		});
		assert.strictEqual(manifest.manifestVersion, 3);
	});

	test("accepts bounded v2 compatibility only for the historical worker", () => {
		const manifest = parse({
			...base,
			manifestVersion: 2,
			worker: "git-commit-generator",
		});
		assert.strictEqual(manifest.manifestVersion, 2);
	});

	test("rejects unauthorized or ambiguous v2 manifests", () => {
		for (const worker of [undefined, "reviewer", ""]) {
			assert.throws(() =>
				parse({
					...base,
					manifestVersion: 2,
					...(worker === undefined ? {} : { worker }),
				}),
			);
		}
	});

	test("rejects every unauthorized v3 target", () => {
		for (const target of [
			{ kind: "host" },
			{ kind: "worker", name: "reviewer" },
			{ kind: "worker", name: "git-commit-generator", model: "unknown" },
		]) {
			assert.throws(() => parse({ ...base, manifestVersion: 3, target }));
		}
	});

	test("rejects unknown compatibility markers", () => {
		assert.throws(() =>
			parse({
				...base,
				manifestVersion: 3,
				target: { kind: "worker", name: "git-commit-generator" },
				targetCompatibility: "legacy-v1",
			}),
		);
	});
});
