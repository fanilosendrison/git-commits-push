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
import { Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "../..");
const compiledSkillDirectory = path.join(
	skillDirectory,
	"dist",
	"skills",
	"git-commits-push",
);
const compiledSupervisorPath = path.join(
	compiledSkillDirectory,
	"src",
	"entrypoints",
	"node-supervisor.js",
);
const compiledValidatorPath = path.join(
	compiledSkillDirectory,
	"src",
	"modules",
	"core",
	"validators",
	"pre-commit-validators.js",
);
const compiledPublisherPath = path.join(
	compiledSkillDirectory,
	"src",
	"modules",
	"git",
	"publisher.js",
);
const pipelineFixturePath = path.join(
	testDirectory,
	"fixtures",
	"pipeline-stage.mjs",
);
const scannerFixturePath = path.join(
	testDirectory,
	"fixtures",
	"security-scanner-stage.mjs",
);
const publisherFixturePath = path.join(
	testDirectory,
	"fixtures",
	"compiled-publisher-harness.mjs",
);
const { supervisePipeline } = await import(
	pathToFileURL(compiledSupervisorPath).href
);

const SECRET_VALUE = `ghp_${"A".repeat(36)}`;
const HOOK_PRIVATE_MARKER = `ghp_${"H".repeat(36)}`;

function createCapture() {
	const chunks = [];
	return {
		stream: new Writable({
			write(chunk, _encoding, callback) {
				chunks.push(Buffer.from(chunk));
				callback();
			},
		}),
		text: () => Buffer.concat(chunks).toString("utf8"),
	};
}

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

function extractNonProtocolBytes(stdout) {
	return stdout.replace(/@@TURNLOCK@@[\s\S]*?@@END@@/g, "").replace(/\s/g, "");
}

async function runCompiledScannerPipeline({
	environment,
	expectedOutcome,
	repositoryPath,
	statsDirectory,
}) {
	const stdout = createCapture();
	const stderr = createCapture();
	const childEnvironment = {
		...environment,
		NODE_ENV: "test",
		PI_SKILL_STATS_DIR: statsDirectory,
		PI_SKILL_STATS_MODE: "",
		SECRET_SCANNER_STATS_DIR: statsDirectory,
	};
	const input = JSON.stringify({
		repositoryPath,
		systemPromptPath: path.join(skillDirectory, "system-prompt.md"),
	});
	const result = await supervisePipeline({
		consumer: {
			args: [
				scannerFixturePath,
				pathToFileURL(compiledValidatorPath).href,
				expectedOutcome,
			],
			command: process.execPath,
			cwd: skillDirectory,
			env: childEnvironment,
		},
		producer: {
			args: [pipelineFixturePath, "argument-producer", input],
			command: process.execPath,
			cwd: skillDirectory,
			env: childEnvironment,
		},
		stderr: stderr.stream,
		stdout: stdout.stream,
	});
	return { result, stderr: stderr.text(), stdout: stdout.text() };
}

test("compiled pipeline blocks secrets without leaking values to output or telemetry", async () => {
	await withTemporaryDirectory("compiled-security-scanner-é-", async (root) => {
		const { environment, repositoryPath } = await createRepository(root);
		const statsDirectory = path.join(root, "scanner telemetry 漢字");
		await mkdir(statsDirectory, { recursive: true });
		await writeFile(
			path.join(repositoryPath, "production-config.ts"),
			`export const accessToken = "${SECRET_VALUE}";\n`,
		);
		runGit(repositoryPath, ["add", "production-config.ts"], environment);

		const { result, stderr, stdout } = await runCompiledScannerPipeline({
			environment,
			expectedOutcome: "block",
			repositoryPath,
			statsDirectory,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(extractNonProtocolBytes(stdout), "");
		assert.match(stdout, /message: secret-scanner-blocked/);
		assert.match(stderr, /compiled secret scanner blocked the repository/);
		assert.doesNotMatch(stdout, new RegExp(SECRET_VALUE));
		assert.doesNotMatch(stderr, new RegExp(SECRET_VALUE));

		const eventsPath = path.join(statsDirectory, "events.jsonl");
		const telemetry = await readFile(eventsPath, "utf8");
		assert.doesNotMatch(telemetry, new RegExp(SECRET_VALUE));
		const events = telemetry
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const blockEvent = events.find((event) => event.eventType === "block");
		assert.equal(blockEvent?.namespace, "secret-scanner");
		assert.equal(blockEvent?.details?.findingsCount, 1);
		assert.equal(blockEvent?.details?.findings?.[0]?.name, "GitHub Token");
		assert.equal(blockEvent?.details?.findings?.[0]?.line, "");
		assert.equal((await stat(eventsPath)).mode & 0o022, 0);
	});
});

test("compiled pipeline preserves non-production scanner warnings without leaking values", async () => {
	await withTemporaryDirectory("compiled-security-warning-é-", async (root) => {
		const { environment, repositoryPath } = await createRepository(root);
		const statsDirectory = path.join(root, "warning telemetry 漢字");
		await mkdir(path.join(repositoryPath, "tests"), { recursive: true });
		await mkdir(statsDirectory, { recursive: true });
		await writeFile(
			path.join(repositoryPath, "tests", "production-config.test.ts"),
			`export const accessToken = "${SECRET_VALUE}";\n`,
		);
		runGit(
			repositoryPath,
			["add", "tests/production-config.test.ts"],
			environment,
		);

		const { result, stderr, stdout } = await runCompiledScannerPipeline({
			environment,
			expectedOutcome: "warning",
			repositoryPath,
			statsDirectory,
		});
		assert.equal(result.exitCode, 0);
		assert.equal(extractNonProtocolBytes(stdout), "");
		assert.match(stdout, /action: DONE/);
		assert.match(stderr, /compiled secret scanner emitted a warning/);
		assert.doesNotMatch(stdout, new RegExp(SECRET_VALUE));
		assert.doesNotMatch(stderr, new RegExp(SECRET_VALUE));

		const telemetry = await readFile(
			path.join(statsDirectory, "events.jsonl"),
			"utf8",
		);
		assert.doesNotMatch(telemetry, new RegExp(SECRET_VALUE));
		const events = telemetry
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const warningEvent = events.find((event) => event.eventType === "warning");
		assert.equal(warningEvent?.namespace, "secret-scanner");
		assert.equal(warningEvent?.details?.findingsCount, 1);
		assert.equal(warningEvent?.details?.findings?.[0]?.line, "");
	});
});

test("compiled scanner errors remain fail-closed", async () => {
	await withTemporaryDirectory(
		"compiled-security-scanner-error-",
		async (root) => {
			const { environment, repositoryPath } = await createRepository(root);
			await writeFile(
				path.join(repositoryPath, "safe-change.ts"),
				"export const safeChange = true;\n",
			);
			runGit(repositoryPath, ["add", "safe-change.ts"], environment);
			const previousNodeEnvironment = process.env.NODE_ENV;
			const previousStatsMode = process.env.PI_SKILL_STATS_MODE;
			process.env.NODE_ENV = "test";
			process.env.PI_SKILL_STATS_MODE = "test";
			try {
				const { processRepoValidationAndDiff } = await import(
					pathToFileURL(compiledValidatorPath).href
				);
				await assert.rejects(
					processRepoValidationAndDiff(
						{ id: "scanner-error-repository", path: repositoryPath },
						{
							autoPush: false,
							model: "security-fixture-model",
							provider: "security-fixture-provider",
							searchPaths: [repositoryPath],
							skipTests: true,
							systemPromptPath: path.join(skillDirectory, "system-prompt.md"),
							temperature: 0,
						},
						async () => {
							throw new Error("scanner unavailable");
						},
					),
					/scanner unavailable/,
				);
			} finally {
				if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
				else process.env.NODE_ENV = previousNodeEnvironment;
				if (previousStatsMode === undefined)
					delete process.env.PI_SKILL_STATS_MODE;
				else process.env.PI_SKILL_STATS_MODE = previousStatsMode;
			}
		},
	);
});

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
