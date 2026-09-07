import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "../..");
const compiledSkillDirectory = path.join(skillDirectory, "dist");
const compiledPublisherPath = path.join(
	compiledSkillDirectory,
	"src",
	"modules",
	"git",
	"publisher.js",
);
const publisherFixturePath = path.join(
	testDirectory,
	"fixtures",
	"compiled-publisher-harness.mjs",
);
const HOOK_PRIVATE_MARKER = `ghp_${"H".repeat(36)}`;

async function withTemporaryDirectory(prefix, callback) {
	const directory = await mkdtemp(path.join(tmpdir(), prefix));
	try {
		await callback(directory);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

function isolatedGitEnvironment(root) {
	return {
		...process.env,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		HOME: path.join(root, "isolated-home"),
		XDG_CONFIG_HOME: path.join(root, "isolated-config"),
	};
}

function runGit(repositoryPath, args, environment) {
	const result = spawnSync("git", args, {
		cwd: repositoryPath,
		encoding: "utf8",
		env: environment,
		shell: false,
	});
	assert.equal(
		result.status,
		0,
		`git ${args.join(" ")} failed: ${result.stderr}`,
	);
	return result.stdout;
}

async function createRepository(root) {
	const repositoryPath = path.join(root, "repository with spaces é");
	await mkdir(repositoryPath, { recursive: true });
	const environment = isolatedGitEnvironment(root);
	await mkdir(environment.HOME, { recursive: true });
	await mkdir(environment.XDG_CONFIG_HOME, { recursive: true });
	runGit(repositoryPath, ["init", "--quiet"], environment);
	runGit(
		repositoryPath,
		["config", "user.name", "Compiled Security"],
		environment,
	);
	runGit(
		repositoryPath,
		["config", "user.email", "compiled-security@example.invalid"],
		environment,
	);
	await writeFile(path.join(repositoryPath, "README.md"), "initial\n");
	runGit(repositoryPath, ["add", "README.md"], environment);
	runGit(
		repositoryPath,
		["commit", "--quiet", "--no-verify", "-m", "initial"],
		environment,
	);
	return { environment, repositoryPath };
}

test("compiled publisher preserves Git modes and trusted hook behavior without output leaks", async () => {
	await withTemporaryDirectory(
		"compiled-security-publisher-é-",
		async (root) => {
			const { environment, repositoryPath } = await createRepository(root);
			const hooksDirectory = path.join(repositoryPath, ".git", "hooks");
			const preCommitSentinel = path.join(root, "pre-commit-ran");
			const postCommitSentinel = path.join(root, "post-commit-ran");
			const preCommitHook = path.join(hooksDirectory, "pre-commit");
			const postCommitHook = path.join(hooksDirectory, "post-commit");
			await writeFile(
				preCommitHook,
				'#!/bin/sh\nprintf "pre" > "$PRE_COMMIT_SENTINEL"\nexit 91\n',
				{ mode: 0o755 },
			);
			await writeFile(
				postCommitHook,
				'#!/bin/sh\nprintf "post" > "$POST_COMMIT_SENTINEL"\nprintf "%s\\n" "$HOOK_PRIVATE_MARKER"\nprintf "%s\\n" "$HOOK_PRIVATE_MARKER" >&2\n',
				{ mode: 0o755 },
			);
			await chmod(preCommitHook, 0o755);
			await chmod(postCommitHook, 0o755);

			const executablePath = path.join(repositoryPath, "executable-script.sh");
			const regularPath = path.join(repositoryPath, "regular-file.txt");
			await writeFile(executablePath, "#!/bin/sh\nprintf 'ok\\n'\n", {
				mode: 0o755,
			});
			await chmod(executablePath, 0o755);
			await writeFile(regularPath, "regular\n", { mode: 0o644 });
			runGit(
				repositoryPath,
				["add", "executable-script.sh", "regular-file.txt"],
				environment,
			);
			const stagedDiff = runGit(
				repositoryPath,
				["diff", "--cached"],
				environment,
			);
			const expectedDiffHash = createHash("sha256")
				.update(stagedDiff)
				.digest("hex");

			const isolatedTemporaryDirectory = path.join(root, "isolated tmp 漢字");
			await mkdir(isolatedTemporaryDirectory, { recursive: true });
			const result = spawnSync(
				process.execPath,
				[
					publisherFixturePath,
					pathToFileURL(compiledPublisherPath).href,
					repositoryPath,
					expectedDiffHash,
				],
				{
					cwd: skillDirectory,
					encoding: "utf8",
					env: {
						...environment,
						HOOK_PRIVATE_MARKER,
						NODE_ENV: "test",
						PI_SKILL_STATS_DIR: path.join(root, "publisher-stats"),
						POST_COMMIT_SENTINEL: postCommitSentinel,
						PRE_COMMIT_SENTINEL: preCommitSentinel,
						TEMP: isolatedTemporaryDirectory,
						TMP: isolatedTemporaryDirectory,
						TMPDIR: isolatedTemporaryDirectory,
					},
					shell: false,
				},
			);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stdout, "");
			assert.equal(result.stderr, "");
			assert.doesNotMatch(result.stdout, new RegExp(HOOK_PRIVATE_MARKER));
			assert.doesNotMatch(result.stderr, new RegExp(HOOK_PRIVATE_MARKER));
			assert.equal(existsSync(preCommitSentinel), false);
			assert.equal(await readFile(postCommitSentinel, "utf8"), "post");
			assert.equal((await stat(preCommitHook)).mode & 0o777, 0o755);
			assert.equal((await stat(postCommitHook)).mode & 0o777, 0o755);

			const tree = runGit(
				repositoryPath,
				["ls-tree", "HEAD", "executable-script.sh", "regular-file.txt"],
				environment,
			);
			assert.match(tree, /^100755 .+\texecutable-script\.sh$/m);
			assert.match(tree, /^100644 .+\tregular-file\.txt$/m);

			const tokenDirectory = path.join(
				isolatedTemporaryDirectory,
				"git-commits-push-trust-tokens",
			);
			const tokenNames = await readdir(tokenDirectory);
			assert.ok(tokenNames.length > 0);
			for (const tokenName of tokenNames) {
				assert.match(tokenName, /^[a-f0-9]{64}$/);
				assert.equal(
					(await stat(path.join(tokenDirectory, tokenName))).mode & 0o777,
					0o600,
				);
				assert.doesNotMatch(result.stdout, new RegExp(tokenName));
				assert.doesNotMatch(result.stderr, new RegExp(tokenName));
			}
		},
	);
});
