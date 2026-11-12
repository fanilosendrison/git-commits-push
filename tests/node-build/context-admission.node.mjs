import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	buildSimplePrompt,
	createOpenAICompatibleAdapter,
} from "@fanilosendrison/llm-runtime";
import { commitJobResultSchema } from "../../dist/src/config/state-schema.js";
import { handleTurnlockDelegation } from "../../dist/src/entrypoints/turnlock-to-llm-bridge.js";
import { classifyLLMFailure } from "../../dist/src/modules/core/error-classifier.js";
import {
	gitExecArgsRaw,
	gitExecBytesArgs,
} from "../../dist/src/modules/git/git-exec.js";
import { admitContext } from "../../dist/src/modules/llm/context-admission.js";
import { buildContextRequest } from "../../dist/src/modules/llm/context-request.js";
import { invokeLlm } from "../../dist/src/modules/llm/llm-invoker.js";
import { PlanningAttemptBudget } from "../../dist/src/modules/llm/planning-attempt-budget.js";
import { createLlmJobFailure } from "../../dist/src/modules/llm/provider-failure.js";
import {
	assertExactPlanningCoverage,
	partitionPlanningPaths,
} from "../../dist/src/modules/planning/exact-partitions.js";
import { syntheticCompiledAuthority } from "./context-profile-fixture.mjs";

test("compiled raw Git bytes and structural retry classification preserve their distinct contracts", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "compiled-raw-git-"));
	try {
		execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
		const bytes = Buffer.from([0, 255, 254]);
		writeFileSync(path.join(dir, "binary.dat"), bytes);
		const oid = execFileSync("git", ["hash-object", "-w", "binary.dat"], {
			cwd: dir,
			encoding: "utf8",
		}).trim();
		assert.deepEqual(gitExecBytesArgs(["cat-file", "blob", oid], dir), bytes);
		assert.equal(
			gitExecArgsRaw(["cat-file", "blob", oid], dir),
			bytes.toString("utf8"),
		);
		assert.throws(
			() => gitExecArgsRaw(["not-a-git-command"], dir),
			(error) => {
				assert.equal(typeof error.stdout, "string");
				assert.equal(typeof error.stderr, "string");
				return true;
			},
		);
		let coverageError;
		try {
			assertExactPlanningCoverage([{ files: ["a"] }], ["a", "b"]);
		} catch (error) {
			coverageError = error;
		}
		const result = createLlmJobFailure("compiled", coverageError);
		assert.equal(
			commitJobResultSchema.parse(result).planningFailureKind,
			"structural",
		);
		assert.equal(
			commitJobResultSchema.safeParse({
				...result,
				providerFailureKind: "rate_limit",
			}).success,
			false,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compiled fatal parse diagnostics cannot grant validation recovery", () => {
	let parseFailure;
	try {
		JSON.parse("validation rejected");
	} catch (error) {
		parseFailure = error;
	}
	const result = createLlmJobFailure("synthetic", parseFailure);
	assert.match(result.error, /validation rejected/u);
	assert.equal(classifyLLMFailure(result.error), null);
	assert.equal(
		classifyLLMFailure("validation rejected: historical extension"),
		"validation",
	);
});

const payload = {
	provider: "mistral",
	model: "synthetic-snapshot",
	token: "unused",
	temperature: 0,
	systemPrompt: "system 😀",
	userPrompt: 'Unicode é \\"',
	responseReserve: 128,
};

test("compiled production invoker refuses unknown profiles before any generation", async () => {
	await assert.rejects(invokeLlm(payload), /CAPABILITY_UNKNOWN/);
	const fake = syntheticCompiledAuthority();
	assert.equal(
		(
			await admitContext(buildContextRequest(payload), {
				...fake,
				scope: "production",
			})
		).status,
		"CAPABILITY_UNKNOWN",
	);
});

test("compiled exact admitted message snapshot and reserve reach real runtime with injected transport", async () => {
	let body;
	const authority = syntheticCompiledAuthority();
	const unexpected = () => {
		throw new Error("unexpected provider");
	};
	const budget = new PlanningAttemptBudget();
	const content = await invokeLlm(
		payload,
		{
			contextAuthority: authority,
			buildSimplePrompt,
			createAnthropicAdapter: unexpected,
			createGoogleAdapter: unexpected,
			createOpenAIAdapter: unexpected,
			createOpenAICompatibleAdapter: (config) =>
				createOpenAICompatibleAdapter({
					...config,
					provider: "mistral",
					providerOptions: {
						fetch: async (_url, options) => {
							body = JSON.parse(options.body);
							return new Response(
								JSON.stringify({
									model: config.model,
									choices: [
										{ message: { content: "OK" }, finish_reason: "stop" },
									],
								}),
								{ status: 200 },
							);
						},
					},
				}),
		},
		budget,
	);
	assert.equal(content, "OK");
	const expected = buildContextRequest(payload);
	assert.deepEqual(body.messages, expected.request.messages);
	assert.equal(body.max_tokens, 128);
	assert.equal(body.model, payload.model);
	assert.equal(budget.snapshot().calls, 1);
});

test("compiled SDK retry rechecks proof expiry before any subsequent physical send", async () => {
	let now = 100;
	let sends = 0;
	const unexpected = () => {
		throw new Error("unexpected provider");
	};
	const fetch = async () => {
		sends++;
		now = 2000;
		return new Response(
			JSON.stringify({ error: { message: "synthetic overload" } }),
			{ status: 503 },
		);
	};
	await assert.rejects(
		invokeLlm(
			payload,
			{
				contextAuthority: { ...syntheticCompiledAuthority(), now: () => now },
				fetch,
				buildSimplePrompt,
				createAnthropicAdapter: unexpected,
				createGoogleAdapter: unexpected,
				createOpenAIAdapter: unexpected,
				createOpenAICompatibleAdapter: (config) =>
					createOpenAICompatibleAdapter({
						...config,
						retry: {
							maxAttempts: config.retry.maxAttempts,
							backoffBaseMs: 0,
							maxBackoffMs: 0,
						},
					}),
			},
			new PlanningAttemptBudget(),
		),
		(error) => error.status === "CAPABILITY_STALE",
	);
	assert.equal(sends, 1);
});

test("compiled partition membership is closed, deterministic and fails on a smaller unknown/oversized path", async () => {
	const requestFor = (p) =>
		buildContextRequest({ ...payload, userPrompt: JSON.stringify(p) });
	const paths = [
		{ path: "b", patch: "b".repeat(100) },
		{ path: 'a\n"', patch: "a".repeat(100) },
	];
	const parts = await partitionPlanningPaths(
		paths,
		requestFor,
		syntheticCompiledAuthority(),
		150,
	);
	assert.deepEqual(
		parts.flatMap((p) => p.paths),
		['a\n"', "b"],
	);
	assertExactPlanningCoverage(
		parts.map((p) => ({ commit: {}, files: p.paths })),
		paths.map((p) => p.path),
	);
	assert.throws(
		() => assertExactPlanningCoverage([{ files: ["b", "b"] }], ["b"]),
		/Duplicate/,
	);
	await assert.rejects(
		partitionPlanningPaths(
			paths,
			requestFor,
			syntheticCompiledAuthority({ inputLimit: 1 }),
			150,
		),
		/indivisible/,
	);
});

test("compiled actual bridge returns a non-transient refusal with no injected inference call", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "compiled-context-"));
	try {
		const manifest = path.join(dir, "manifest.json"),
			resultPath = path.join(dir, "result.json");
		writeFileSync(
			manifest,
			JSON.stringify({
				manifestVersion: 3,
				runId: "synthetic",
				orchestratorName: "git-commits-push-tl",
				phase: "discovery-and-validation",
				resumeAt: "commit-and-push",
				label: "planning",
				kind: "batch",
				emittedAt: new Date(0).toISOString(),
				emittedAtEpochMs: 0,
				timeoutMs: 600000,
				deadlineAtEpochMs: 600000,
				attempt: 0,
				maxAttempts: 1,
				target: { kind: "worker", name: "git-commit-generator" },
				jobs: [
					{
						id: "synthetic",
						resultPath,
						prompt: JSON.stringify({
							repository: dir,
							provider: "mistral",
							model: "dynamic-latest",
							contextProfile: {
								scope: "production",
								inputLimit: 10000000,
								outputLimit: 65536,
								provenance: "untrusted job claim",
							},
							contextAuthority: { scope: "test" },
							temperature: 0,
							systemPrompt: "system",
							diff: "work",
							diffHash: "hash",
						}),
					},
				],
			}),
		);
		let calls = 0;
		await handleTurnlockDelegation(manifest, "synthetic-no-resume", () => "", {
			resolveAuthToken: async () => "synthetic",
			invokeLlm: async () => {
				calls++;
				throw new Error("must not generate");
			},
		});
		const result = JSON.parse(readFileSync(resultPath, "utf8"));
		assert.equal(result.success, false);
		assert.match(result.error, /CAPABILITY_UNKNOWN/);
		assert.equal(result.providerFailureKind, undefined);
		assert.equal(calls, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
