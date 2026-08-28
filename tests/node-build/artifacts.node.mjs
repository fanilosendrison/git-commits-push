import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "../..");
const distDirectory = path.join(skillDirectory, "dist");
const compiledSkillDirectory = path.join(
	distDirectory,
	"skills",
	"git-commits-push",
);
const entrypointDirectory = path.join(
	compiledSkillDirectory,
	"src",
	"entrypoints",
);
const entrypointNames = [
	"node-supervisor",
	"turnlock-orchestrator",
	"turnlock-to-llm-bridge",
];

async function readArtifact(relativePath) {
	return readFile(path.join(distDirectory, relativePath));
}

test("emits the compiled supervisor and both pipeline entrypoints", async () => {
	for (const entrypointName of entrypointNames) {
		for (const extension of ["js", "js.map", "d.ts", "d.ts.map"]) {
			const artifactPath = path.join(
				entrypointDirectory,
				`${entrypointName}.${extension}`,
			);
			assert.equal((await stat(artifactPath)).isFile(), true, artifactPath);
		}
	}
});

test("copies runtime assets byte-for-byte with deterministic modes", async () => {
	const assets = [
		{
			source: "src/config/settings.json",
			destination: "skills/git-commits-push/src/config/settings.json",
		},
		{
			source: "system-prompt.md",
			destination: "skills/git-commits-push/system-prompt.md",
		},
	];

	for (const asset of assets) {
		const sourcePath = path.join(skillDirectory, asset.source);
		const destinationPath = path.join(distDirectory, asset.destination);
		assert.deepEqual(
			await readFile(destinationPath),
			await readFile(sourcePath),
		);
		assert.equal((await stat(destinationPath)).mode & 0o777, 0o644);
	}
});

test("rewrites relative TypeScript imports and removes Bun-only module globals", async () => {
	const forbiddenPatterns = [
		/import\.meta\.(?:dir|main)\b/,
		/\b__dirname\b/,
		/from\s+["'][^"']+\.ts["']/,
	];
	const localSkillPath = skillDirectory.replaceAll("\\", "/");

	for (const entrypointName of entrypointNames) {
		const source = await readArtifact(
			`skills/git-commits-push/src/entrypoints/${entrypointName}.js`,
		).then((content) => content.toString("utf8"));
		for (const forbiddenPattern of forbiddenPatterns) {
			assert.doesNotMatch(source, forbiddenPattern);
		}
		assert.equal(source.includes(localSkillPath), false);
	}
});

test("imports compiled entrypoints without starting any process", async () => {
	for (const entrypointName of entrypointNames) {
		const entrypointUrl = pathToFileURL(
			path.join(entrypointDirectory, `${entrypointName}.js`),
		).href;
		await import(`${entrypointUrl}?import-smoke=${entrypointName}`);
	}
});

test("detects direct execution through physical and symlinked paths", async () => {
	const helperPath = path.join(
		compiledSkillDirectory,
		"src",
		"utils",
		"direct-execution.js",
	);
	const helperUrl = pathToFileURL(helperPath).href;
	const { isDirectExecution } = await import(helperUrl);
	assert.equal(isDirectExecution(helperUrl, undefined), false);
	assert.equal(isDirectExecution(helperUrl, helperPath), true);

	const temporaryDirectory = await mkdtemp(
		path.join(tmpdir(), "git-commits-push-entrypoint-é-"),
	);
	try {
		const gatewayPath = path.join(
			temporaryDirectory,
			"entrypoint with spaces.js",
		);
		await symlink(helperPath, gatewayPath);
		assert.equal(isDirectExecution(helperUrl, gatewayPath), true);
	} finally {
		await rm(temporaryDirectory, { force: true, recursive: true });
	}
});
