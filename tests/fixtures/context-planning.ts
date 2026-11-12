import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	buildSimplePrompt,
	createOpenAICompatibleAdapter,
} from "@fanilosendrison/llm-runtime";
import { commitJobResultSchema } from "../../src/config/state-schema.ts";
import { handleTurnlockDelegation } from "../../src/entrypoints/turnlock-to-llm-bridge.ts";
import { processRepoValidationAndDiff } from "../../src/modules/core/validators/pre-commit-validators.ts";
import {
	invokeLlm,
	type LlmAdapterFactories,
} from "../../src/modules/llm/llm-invoker.ts";
import { planningSourceFor } from "../../src/modules/planning/planning-source.ts";
import type {
	CommitJobPayload,
	CommitPlanningPayload,
	Settings,
} from "../../src/types.ts";
import { syntheticContextAuthority } from "../helpers/context-authority.ts";
import { GitRepoFixture } from "./git-repo.ts";

export const settings: Settings = {
	searchPaths: [],
	provider: "mistral",
	model: "synthetic-snapshot",
	temperature: 0,
	systemPromptPath: "unused",
	autoPush: true,
	skipTests: true,
	maxDiffChars: 250,
};
export const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Controlled real source with independent binary/mode/deletion/literal-path oracles. */
export async function fixture(
	transition?: "file-to-directory" | "directory-to-file",
) {
	const repo = GitRepoFixture.create();
	const remote = mkdtempSync(path.join(tmpdir(), "context-bare-"));
	try {
		writeFileSync(path.join(repo.dir, "gone.txt"), "old\n");
		writeFileSync(path.join(repo.dir, "old name.txt"), "rename me\n");
		writeFileSync(path.join(repo.dir, "mode.sh"), "exit 0\n");
		writeFileSync(path.join(repo.dir, "binary.dat"), Buffer.from([0, 1, 2, 3]));
		if (transition === "file-to-directory")
			writeFileSync(path.join(repo.dir, "node"), "old file\n");
		if (transition === "directory-to-file") {
			mkdirSync(path.join(repo.dir, "node"));
			writeFileSync(path.join(repo.dir, "node/child"), "old child\n");
		}
		repo.commit("baseline");
		git(remote, "init", "--bare");
		repo.setRemote("origin", remote);
		git(repo.dir, "push", "-u", "origin", "HEAD");
		const head = git(repo.dir, "rev-parse", "HEAD");
		unlinkSync(path.join(repo.dir, "gone.txt"));
		renameSync(
			path.join(repo.dir, "old name.txt"),
			path.join(repo.dir, "new name.txt"),
		);
		chmodSync(path.join(repo.dir, "mode.sh"), 0o755);
		writeFileSync(
			path.join(repo.dir, "binary.dat"),
			Buffer.from([0, 9, 255, 254]),
		);
		writeFileSync(
			path.join(repo.dir, 'unicode-😀-".txt'),
			'Unicode é 😀 � \\"\n',
		);
		if (transition === "file-to-directory") {
			unlinkSync(path.join(repo.dir, "node"));
			mkdirSync(path.join(repo.dir, "node"));
			writeFileSync(path.join(repo.dir, "node/child"), "new child\n");
		}
		if (transition === "directory-to-file") {
			rmSync(path.join(repo.dir, "node"), { recursive: true });
			writeFileSync(path.join(repo.dir, "node"), "new file\n");
		}
		const validated = await processRepoValidationAndDiff(
			{ id: "fixture", path: repo.dir },
			settings,
			async () => ({ hasSecrets: false, matchCount: 0 }),
		);
		const source = planningSourceFor(
			{
				repository: repo.dir,
				status: "RUNNING",
				validatedSource: validated.validatedSource,
			},
			settings,
		);
		assert.ok(source);
		const payload: CommitPlanningPayload = {
			...settings,
			repository: repo.dir,
			diff: validated.diff,
			diffHash: validated.diffHash,
			systemPrompt:
				"Return valid commit plans for the exact authoritative paths.",
			planningSource: { ...source, maxDiffChars: 800 },
		};
		return {
			repo,
			remote,
			head,
			validated,
			payload,
			dispose: () => {
				repo.dispose();
				rmSync(remote, { recursive: true, force: true });
			},
		};
	} catch (error) {
		repo.dispose();
		rmSync(remote, { recursive: true, force: true });
		throw error;
	}
}

/** Real runtime binding, but synthetic profile and local injected HTTP responses only. */
export function transport(
	f: Awaited<ReturnType<typeof fixture>>,
	failAfter?: number,
	inputLimit = 10_000_000,
	schemaValidOmission = false,
) {
	const authority = syntheticContextAuthority({ inputLimit });
	const calls: string[][] = [];
	const unexpected = () => {
		throw new Error("unexpected provider");
	};
	const factories: LlmAdapterFactories = {
		contextAuthority: authority,
		buildSimplePrompt,
		createAnthropicAdapter: unexpected,
		createGoogleAdapter: unexpected,
		createOpenAIAdapter: unexpected,
		createOpenAICompatibleAdapter,
		fetch: async (_url, options) => {
			assert.equal(
				git(f.repo.dir, "rev-parse", "HEAD"),
				f.head,
				"no commit before complete aggregation",
			);
			assert.equal(
				git(f.remote, "rev-parse", "HEAD"),
				f.head,
				"no remote effect before aggregate",
			);
			if (typeof options?.body !== "string")
				throw new Error("Expected JSON body");
			const body = JSON.parse(options.body);
			assert.equal(body.max_tokens, 4096);
			const user = body.messages.find(
				(m: { role: string }) => m.role === "user",
			).content as string;
			const header = JSON.parse(
				user.split("\n")[0]?.slice("AUTHORITATIVE_PARTITION ".length) ?? "",
			);
			assert.equal(header.T, f.validated.validatedSource.expectedTreeSha);
			assert.equal(
				header.fullDiffHash,
				f.validated.validatedSource.fullDiffHash,
			);
			calls.push(header.paths);
			const plan = {
				commit: {
					type: "fix",
					description: "preserve qualified path changes",
					isBreaking: false,
				},
				files: header.paths,
			};
			const plans =
				failAfter !== undefined && calls.length > failAfter
					? schemaValidOmission
						? [{ ...plan, files: header.paths.slice(0, -1) }]
						: []
					: [plan];
			return new Response(
				JSON.stringify({
					model: body.model,
					choices: [
						{
							message: { content: JSON.stringify(plans) },
							finish_reason: "stop",
						},
					],
				}),
				{ status: 200 },
			);
		},
	};
	return {
		authority,
		calls,
		invoke: ((payload, _unused, budget) =>
			invokeLlm(payload, factories, budget)) as typeof invokeLlm,
	};
}

export async function fixtureBridge(
	f: Awaited<ReturnType<typeof fixture>>,
	t: ReturnType<typeof transport>,
	payload: CommitJobPayload = f.payload,
	label = "planning",
) {
	const resultPath = path.join(f.remote, `${label}-result.json`);
	const manifestPath = path.join(f.remote, `${label}-manifest.json`);
	writeFileSync(
		manifestPath,
		JSON.stringify({
			manifestVersion: 3,
			runId: "synthetic-context-job",
			orchestratorName: "git-commits-push-tl",
			phase: "discovery-and-validation",
			resumeAt: "commit-and-push",
			label: "synthetic-planning",
			kind: "batch",
			emittedAt: new Date(0).toISOString(),
			emittedAtEpochMs: 0,
			timeoutMs: 600000,
			deadlineAtEpochMs: 600000,
			attempt: 0,
			maxAttempts: 1,
			target: { kind: "worker", name: "git-commit-generator" },
			jobs: [{ id: "fixture", prompt: JSON.stringify(payload), resultPath }],
		}),
	);
	await handleTurnlockDelegation(
		manifestPath,
		"synthetic-no-resume",
		() => "",
		{
			invokeLlm: t.invoke,
			contextAuthority: t.authority,
			resolveAuthToken: async () => "synthetic",
		},
	);
	return commitJobResultSchema.parse(
		JSON.parse(readFileSync(resultPath, "utf8")),
	);
}
