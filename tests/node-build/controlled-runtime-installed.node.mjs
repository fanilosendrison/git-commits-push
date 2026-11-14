import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
	installCreateQualification,
	startInstalled,
	withCreateFixture,
} from "./fixtures/create-installed-qualification.mjs";
import { runGit } from "./fixtures/reconciler-e2e-helpers.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const preload = pathToFileURL(
	path.join(import.meta.dirname, "fixtures/controlled-runtime-fetch.mjs"),
).href;
let candidate;
before(async () => {
	candidate = await installCreateQualification();
});
after(async () => {
	await candidate?.cleanup();
});

test("standalone contains exact upstream package bytes/provenance but no original tarball", async () => {
	const provenance = JSON.parse(
		readFileSync(
			path.join(
				candidate.releaseDirectory,
				"dist/dependency-provenance/llm-runtime.json",
			),
			"utf8",
		),
	);
	assert.equal(
		provenance.sha256,
		"f27f5b12adcb50d28fadbdc96ca201de6c861add8ca4ed919f8570e7de5a9353",
	);
	assert.equal(
		provenance.sourceCommit,
		"f2ab2f723775bbfe8a40a597be84769819eb1e0e",
	);
	assert.equal(
		existsSync(path.join(candidate.releaseDirectory, "vendor")),
		false,
	);
	const installRoot = path.resolve(
		candidate.paths.applicationDirectory,
		"../..",
	);
	assert.equal(existsSync(path.join(installRoot, "deployment-source")), false);
	const dependency = path.join(
		candidate.releaseDirectory,
		"node_modules/@fanilosendrison/llm-runtime",
	);
	for (const entry of provenance.files) {
		const bytes = readFileSync(path.join(dependency, entry.path));
		assert.equal(
			createHash("sha256").update(bytes).digest("hex"),
			entry.sha256,
		);
	}
	assert.equal(
		existsSync(
			path.join(candidate.releaseDirectory, "node_modules/typescript"),
		),
		false,
	);
	assert.equal(
		existsSync(path.join(candidate.releaseDirectory, "node_modules/.bin/pnpm")),
		false,
	);
});

for (const scenario of [
	"google",
	"string",
	"chunks",
	"malformed",
	"overflow",
	"fallback",
])
	test(`actual installed controlled runtime ${scenario} preserves source, aggregate and remote gates`, async () => {
		await withCreateFixture(candidate, async (f) => {
			const files =
				scenario === "fallback"
					? ["a.ts", "b.ts", "c.ts", "d.ts"]
					: scenario === "overflow"
						? ["a.ts", "b.ts"]
						: ["a.ts"];
			for (const file of files)
				writeFileSync(
					path.join(f.worktree, file),
					scenario === "fallback"
						? "Synthetic data only.\n".repeat(1000)
						: "Synthetic data only.\n",
				);
			runGit(f.worktree, ["add", "--all"], f.env);
			const tree = runGit(f.worktree, ["write-tree"], f.env);
			const settings = {
				...f.settings,
				provider:
					scenario === "google" || scenario === "fallback"
						? "google"
						: "mistral",
				model: scenario === "fallback" ? "primary" : "synthetic",
				autoPush: true,
				...(scenario === "fallback"
					? { fallbackProvider: "mistral", fallbackModel: "smaller" }
					: {}),
			};
			writeFileSync(
				f.env.TURNLOCK_SKILL_SETTINGS_PATH,
				JSON.stringify(settings),
			);
			const stateFile = path.join(f.root, "controlled-state.json");
			writeFileSync(
				stateFile,
				JSON.stringify({
					base: f.B,
					tree,
					repository: f.worktree,
					paths: files,
					scenario,
					calls: [],
				}),
			);
			const result = await startInstalled(candidate, f, f.args, {
				NODE_OPTIONS: `--import=${preload}`,
				GOOGLE_API_KEY: "synthetic",
				MISTRAL_API_KEY: "synthetic",
				GCP_CONTROLLED_RELEASE: candidate.releaseDirectory,
				GCP_FORBIDDEN_SOURCE: root,
				GCP_CONTROLLED_STATE: stateFile,
			}).done();
			const state = JSON.parse(readFileSync(stateFile, "utf8"));
			assert.equal(result.output.includes("PRIVATE_REASONING_SENTINEL"), false);
			assert.equal(
				result.output.includes('"status":"CONTEXT_CAPACITY_PROVEN"'),
				false,
			);
			const head = runGit(f.worktree, ["rev-parse", "HEAD"], f.env);
			const remote = runGit(
				f.remote,
				["for-each-ref", "--format=%(objectname)", "refs/heads/task"],
				f.env,
			);
			if (scenario === "malformed") {
				assert.notEqual(result.code, 0, result.output);
				assert.equal(head, f.B);
				assert.equal(remote, "");
				assert.equal(state.calls.length, 1);
				assert.equal(runGit(f.worktree, ["write-tree"], f.env), tree);
			} else {
				assert.equal(result.code, 0, result.output);
				assert.equal(remote, head);
				assert.equal(
					runGit(f.worktree, ["rev-parse", "HEAD^{tree}"], f.env),
					tree,
				);
				const actual = runGit(
					f.worktree,
					["diff", "--name-only", "--no-renames", f.B, head],
					f.env,
				)
					.split("\n")
					.sort();
				assert.deepEqual(actual, [...files].sort());
				if (scenario === "overflow") assert.equal(state.calls.length, 3);
				if (scenario === "fallback") {
					assert.ok(state.calls.some((c) => c.model === "smaller"));
					assert.equal(
						state.calls.filter((c) => c.model === "primary").length,
						6,
					);
				}
			}
		});
	});
