import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	buildSimplePrompt,
	createOpenAICompatibleAdapter,
} from "@fanilosendrison/llm-runtime";
import {
	commitJobResultSchema,
	stateSchema,
} from "../../src/config/state-schema.ts";
import { handleTurnlockDelegation } from "../../src/entrypoints/turnlock-to-llm-bridge.ts";
import { productionContextAuthority } from "../../src/modules/llm/context-admission.ts";
import {
	invokeLlm,
	type LlmAdapterFactories,
} from "../../src/modules/llm/llm-invoker.ts";
import { extractTurnlockBlocks } from "../../src/modules/turnlock/protocol-blocks.ts";
import type {
	CommitJobResult,
	CommitPlanningPayload,
	GlobalState,
} from "../../src/types.ts";
import {
	fixture,
	fixtureBridge,
	git,
	settings,
} from "../fixtures/context-planning.ts";
import {
	computeStateJson,
	writeLLMResultToTurnlockRunDir,
} from "../helpers/test-helpers.ts";

const RUN = "01J00000000000000000000000";
const orchestrator = fileURLToPath(
	new URL("../../src/entrypoints/turnlock-orchestrator.ts", import.meta.url),
);

/** Read the real SQLite authority and independently verify its stored digest. */
function durableState(root: string): GlobalState {
	const db = new DatabaseSync(
		path.join(root, "runs", "git-commits-push-tl", RUN, "turnlock.sqlite3"),
		{ readOnly: true },
	);
	try {
		const row = db
			.prepare(
				"SELECT state_json, state_digest FROM run_state WHERE singleton = 1",
			)
			.get();
		assert.ok(row);
		assert.equal(typeof row.state_json, "string");
		const json = String(row.state_json);
		assert.equal(
			row.state_digest,
			`sha256:${createHash("sha256").update(json).digest("hex")}`,
		);
		return stateSchema.parse(JSON.parse(json).data);
	} finally {
		db.close();
	}
}
function resume(root: string, settingsPath: string) {
	const result = spawnSync(
		process.execPath,
		[orchestrator, "--resume", "--run-id", RUN],
		{
			encoding: "utf8",
			timeout: 60000,
			env: {
				...process.env,
				TURNLOCK_RUN_DIR_ROOT: path.join(root, "runs"),
				TURNLOCK_SKILL_SETTINGS_PATH: settingsPath,
				PI_SKILL_STATS_MODE: "test",
			},
		},
	);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	const block = extractTurnlockBlocks(result.stdout);
	assert.ok(block.manifestPath, result.stdout);
	return block.manifestPath;
}
function wire(init?: RequestInit): {
	model: string;
	paths: string[];
	T: string;
	fullDiffHash: string;
} {
	assert.equal(typeof init?.body, "string");
	const body = JSON.parse(String(init?.body));
	const user = body.messages.find((m: { role: string }) => m.role === "user")
		.content as string;
	return {
		model: body.model,
		...JSON.parse(
			user.split("\n")[0]?.slice("AUTHORITATIVE_PARTITION ".length) ?? "",
		),
	};
}
function answer(paths: string[]) {
	return new Response(
		JSON.stringify({
			choices: [
				{
					message: {
						content: JSON.stringify([
							{
								commit: {
									type: "fix",
									description: "preserve complete source",
									isBreaking: false,
								},
								files: paths,
							},
						]),
					},
					finish_reason: "stop",
				},
			],
		}),
		{ status: 200 },
	);
}

for (const scenario of [
	"smaller",
	"larger",
	"exhausted",
	"missing",
	"regressing",
] as const)
	test(`real bridge -> phase -> SQLite -> resumed ${scenario} fallback preserves consumption and source`, async () => {
		const f = await fixture();
		try {
			const root = f.remote;
			const settingsPath = path.join(root, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					...settings,
					maxDiffChars: 100000,
					fallbackProvider: "mistral",
					fallbackModel: `fallback-${scenario}`,
				}),
			);
			const prior = {
				calls: scenario === "exhausted" ? 62 : 3,
				recoveries: scenario === "exhausted" ? 4 : 1,
				malformed: 0,
				proofs: 0,
			};
			let primarySends = 0;
			let fallbackSends = 0;
			const seenFallback: string[][] = [];
			const unexpected = () => {
				throw new Error("unexpected provider");
			};
			const factories: LlmAdapterFactories = {
				buildSimplePrompt,
				createAnthropicAdapter: unexpected,
				createGoogleAdapter: unexpected,
				createOpenAIAdapter: unexpected,
				createOpenAICompatibleAdapter: (config) =>
					createOpenAICompatibleAdapter({
						...config,
						retry: {
							maxAttempts: config.retry?.maxAttempts ?? 1,
							backoffBaseMs: 0,
							maxBackoffMs: 0,
						},
					}),
				fetch: async (_input, init) => {
					const request = wire(init);
					assert.equal(request.T, f.validated.validatedSource.expectedTreeSha);
					assert.equal(
						request.fullDiffHash,
						f.validated.validatedSource.fullDiffHash,
					);
					assert.equal(git(f.repo.dir, "rev-parse", "HEAD"), f.head);
					assert.equal(git(f.remote, "rev-parse", "HEAD"), f.head);
					if (!request.model.startsWith("fallback-")) {
						primarySends++;
						return primarySends === 1
							? answer(request.paths)
							: new Response('{"error":{"message":"outage"}}', { status: 503 });
					}
					fallbackSends++;
					seenFallback.push(request.paths);
					return scenario === "smaller" && request.paths.length > 1
						? new Response('{"code":"invalid_request_prompt_too_long"}', {
								status: 400,
							})
						: answer(request.paths);
				},
			};
			const invoke: typeof invokeLlm = (payload, _unused, budget) =>
				invokeLlm(payload, factories, budget);
			const failed = await fixtureBridge(
				f,
				{ invoke, authority: productionContextAuthority, calls: [] },
				{ ...f.payload, planningBudget: prior },
				"primary",
			);
			assert.equal(failed.success, false);
			if (failed.success) throw new Error("Expected partial planning failure");
			assert.equal(failed.providerFailureKind, "transient_provider");
			assert.equal(failed.planningBudget?.calls, prior.calls + 2);
			assert.equal(failed.planningBudget?.recoveries, 4);
			assert.equal(primarySends, scenario === "exhausted" ? 2 : 5);
			assert.equal("commits" in failed, false);
			const seeded: GlobalState = {
				invocationScope: { kind: "worktree", repository: f.repo.dir },
				repos: {
					fixture: {
						repository: f.repo.dir,
						operation: "commit-and-push",
						status: "RUNNING",
						validatedSource: f.validated.validatedSource,
						diffHash: f.validated.diffHash,
						planningBudget: prior,
					},
				},
			};
			computeStateJson(root, seeded, RUN);
			let result: CommitJobResult = failed;
			if (scenario === "missing") {
				const { planningBudget: _removed, ...rest } = failed;
				result = rest;
			}
			if (scenario === "regressing")
				result = { ...failed, planningBudget: { ...prior, calls: 2 } };
			writeLLMResultToTurnlockRunDir(root, "fixture", result, RUN);
			const nextManifest = resume(root, settingsPath);
			const settled = durableState(root).repos.fixture;
			assert.ok(settled);
			assert.equal(git(f.repo.dir, "rev-parse", "HEAD"), f.head);
			assert.equal(git(f.remote, "rev-parse", "HEAD"), f.head);
			if (scenario === "missing" || scenario === "regressing") {
				assert.equal(settled.status, "FAILED");
				assert.match(settled.error ?? "", /budget receipt/);
				assert.deepEqual(settled.planningBudget, prior);
				assert.equal(settled.fallbackAttempted, undefined);
				assert.equal(fallbackSends, 0);
				return;
			}
			assert.deepEqual(settled.planningBudget, failed.planningBudget);
			assert.equal(settled.fallbackAttempted, true);
			assert.equal(settled.attempts?.provider, 1);
			const manifest = JSON.parse(readFileSync(nextManifest, "utf8"));
			const queued = JSON.parse(
				manifest.jobs[0].prompt,
			) as CommitPlanningPayload;
			assert.deepEqual(queued.planningBudget, failed.planningBudget);
			assert.equal(queued.model, `fallback-${scenario}`);
			assert.equal(
				queued.planningSource?.witness.expectedTreeSha,
				f.validated.validatedSource.expectedTreeSha,
			);
			await handleTurnlockDelegation(
				nextManifest,
				"fixture-no-resume",
				() => "",
				{
					invokeLlm: invoke,
					resolveAuthToken: async () => "synthetic",
				},
			);
			const fallback = commitJobResultSchema.parse(
				JSON.parse(readFileSync(manifest.jobs[0].resultPath, "utf8")),
			);
			if (scenario === "exhausted") {
				assert.equal(fallback.success, false);
				assert.equal(fallbackSends, 0);
				assert.equal(fallback.planningBudget?.calls, 64);
				resume(root, settingsPath);
				assert.equal(durableState(root).repos.fixture?.status, "FAILED");
				assert.equal(git(f.repo.dir, "rev-parse", "HEAD"), f.head);
				assert.equal(git(f.remote, "rev-parse", "HEAD"), f.head);
				return;
			}
			assert.equal(fallback.success, true);
			if (!fallback.success) throw new Error("Expected complete fallback plan");
			assert.equal(
				fallback.planningBudget?.calls,
				prior.calls + 2 + fallbackSends,
			);
			assert.equal(fallback.planningBudget?.recoveries, 4);
			assert.deepEqual(
				fallback.commits.flatMap((p) => p.files).sort(),
				[...f.validated.validatedSource.expectedChangedPaths].sort(),
			);
			assert.equal(fallbackSends, scenario === "smaller" ? 11 : 1);
			assert.equal(seenFallback[0]?.length, 6);
			assert.equal(git(f.repo.dir, "rev-parse", "HEAD"), f.head);
			resume(root, settingsPath);
			const completed = durableState(root).repos.fixture;
			assert.equal(completed?.status, "SUCCESS");
			assert.deepEqual(completed?.planningBudget, fallback.planningBudget);
			assert.equal(
				git(f.repo.dir, "rev-parse", "HEAD^{tree}"),
				f.validated.validatedSource.expectedTreeSha,
			);
			assert.equal(git(f.remote, "rev-parse", "HEAD"), completed?.publishedSha);
		} finally {
			f.dispose();
		}
	});
