/**
 * Installed-artifact qualification for targeted mode.
 *
 * Every test in this file exercises the standalone installed public launcher
 * (`bin/git-commits-push.mjs` through the stable public symlink) rather than
 * importing or spawning the source launcher. Two execution modes are
 * supported:
 *
 * - Normal CI/test mode (default): the current source is installed into an
 *   isolated HOME and XDG_DATA_HOME through the production installer, and the
 *   resulting public symlink is the binary under test.
 * - Real installed-release mode: `GCP_QUALIFY_PUBLIC_BIN` names the binary to
 *   exercise. The test never installs another release in this mode.
 *
 * The LLM boundary is the existing deterministic Node preload mock, and Git
 * fixtures reuse the shared reconciler E2E helpers. No production hook is
 * introduced here.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	startLlmOverlapServer,
	waitForCondition,
} from "./fixtures/execution-lifetime-helpers.mjs";
import { resolvePathExecutable } from "./fixtures/path-executable.mjs";
import { resolvePnpmOfflineEnvironment } from "./fixtures/pnpm-offline-environment.mjs";
import {
	createRepoWithBareRemote,
	isolatedEnvironment,
	readJsonLines,
	runGit,
	waitForClose,
} from "./fixtures/reconciler-e2e-helpers.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(testDirectory, "../..");
const compiledInstallerUrl = pathToFileURL(
	path.join(
		repositoryDirectory,
		"dist",
		"src",
		"modules",
		"installation",
		"standalone-installer.js",
	),
).href;
const overlapPreloadPath = path.join(
	testDirectory,
	"fixtures",
	"mock-openai-fetch-overlap.mjs",
);
const reconcilerPreloadPath = path.join(
	testDirectory,
	"fixtures",
	"mock-openai-fetch-reconciler.mjs",
);
const RELEASE_NAME_PATTERN = /^0\.10\.0-[a-f0-9]{64}$/;
const SYNTHETIC_API_KEY = `sk-${"Q".repeat(48)}`;

let qualification = null;
let qualificationRoot = null;

/**
 * ASCII-only temporary root: macOS may normalize non-ASCII temporary prefixes
 * differently between Node and Git, which would make canonical-path comparisons
 * fail for reasons unrelated to the runtime under test.
 */
async function withAsciiTemporaryDirectory(callback) {
	const directory = await mkdtemp(path.join(tmpdir(), "gcp-targeted-release-"));
	try {
		await callback(directory);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

before(async () => {
	const configuredBinary = process.env.GCP_QUALIFY_PUBLIC_BIN;
	if (configuredBinary !== undefined && configuredBinary !== "") {
		assert.equal(
			path.isAbsolute(configuredBinary),
			true,
			"GCP_QUALIFY_PUBLIC_BIN must be an absolute path",
		);
		await access(configuredBinary);
		const publicExecutableRealPath = await realpath(configuredBinary);
		assert.equal(
			path.basename(publicExecutableRealPath),
			"git-commits-push.mjs",
		);
		assert.equal(path.basename(path.dirname(publicExecutableRealPath)), "bin");
		const releaseDirectory = path.dirname(
			path.dirname(publicExecutableRealPath),
		);
		const releaseName = path.basename(releaseDirectory);
		assert.match(releaseName, RELEASE_NAME_PATTERN);
		qualificationRoot = await mkdtemp(
			path.join(tmpdir(), "gcp-targeted-qualify-real-"),
		);
		qualification = {
			publicExecutablePath: configuredBinary,
			publicExecutableRealPath,
			releaseDirectory,
			releaseName,
		};
	} else {
		qualificationRoot = await mkdtemp(
			path.join(tmpdir(), "gcp-targeted-qualify-install-"),
		);
		const homeDirectory = path.join(qualificationRoot, "isolated home");
		const dataHome = path.join(qualificationRoot, "isolated data");
		const pnpmCliPath =
			process.env.npm_execpath ?? (await resolvePathExecutable("pnpm"));
		const environment = {
			...resolvePnpmOfflineEnvironment(pnpmCliPath, repositoryDirectory),
			XDG_DATA_HOME: dataHome,
		};
		const { installStandalone } = await import(compiledInstallerUrl);
		const installation = await installStandalone({
			environment,
			homeDirectory,
			pnpmCliPath,
			sourceDirectory: repositoryDirectory,
		});
		assert.match(installation.releaseName, RELEASE_NAME_PATTERN);
		const publicExecutableRealPath = await realpath(
			installation.paths.publicExecutablePath,
		);
		qualification = {
			publicExecutablePath: installation.paths.publicExecutablePath,
			publicExecutableRealPath,
			releaseDirectory: installation.releaseDirectory,
			releaseName: installation.releaseName,
		};
	}

	const releaseManifest = JSON.parse(
		await readFile(
			path.join(qualification.releaseDirectory, "package.json"),
			"utf8",
		),
	);
	assert.equal(releaseManifest.version, "0.10.0");
	assert.equal(
		existsSync(
			path.join(qualification.releaseDirectory, "dist", "system-prompt.md"),
		),
		true,
	);
	assert.equal(
		qualification.publicExecutableRealPath,
		await realpath(
			path.join(qualification.releaseDirectory, "bin", "git-commits-push.mjs"),
		),
	);
});

after(async () => {
	if (qualificationRoot !== null) {
		await rm(qualificationRoot, { force: true, recursive: true });
	}
});

function tryRunGit(cwd, args, environment) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: environment,
		shell: false,
	});
	return {
		status: result.status,
		stderr: (result.stderr ?? "").trim(),
		stdout: (result.stdout ?? "").trim(),
	};
}

function captureRepositoryState(
	repositoryPath,
	environment,
	excludedBranchRefs = [],
) {
	const branch = tryRunGit(
		repositoryPath,
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		environment,
	);
	const branchRefs = runGit(
		repositoryPath,
		["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"],
		environment,
	);
	return {
		branch: branch.status === 0 ? branch.stdout : null,
		detached: branch.status !== 0,
		// A linked sibling worktree shares the repository ref store, so only the
		// sibling's own branch refs are comparable across an invocation.
		branchRefs: branchRefs
			.split("\n")
			.filter(
				(line) => !excludedBranchRefs.some((ref) => line.startsWith(`${ref} `)),
			)
			.join("\n"),
		head: runGit(repositoryPath, ["rev-parse", "HEAD"], environment),
		indexDiff: runGit(repositoryPath, ["diff", "--cached"], environment),
		localConfig: runGit(
			repositoryPath,
			["config", "--local", "--list"],
			environment,
		),
		status: runGit(repositoryPath, ["status", "--porcelain=v1"], environment),
		workingTreeDiff: runGit(repositoryPath, ["diff"], environment),
	};
}

function resolveGitPath(repositoryPath, gitPath, environment) {
	return path.resolve(
		repositoryPath,
		runGit(repositoryPath, ["rev-parse", "--git-path", gitPath], environment),
	);
}

async function prepareQualificationRoot(root, environment) {
	await mkdir(environment.HOME, { recursive: true });
	await mkdir(environment.XDG_CONFIG_HOME, { recursive: true });
	for (const directory of [
		path.join(root, "reconciler state"),
		path.join(root, "telemetry"),
		path.join(root, "scanner telemetry"),
		path.join(root, "turnlock runs"),
	]) {
		await mkdir(directory, { recursive: true });
	}
}

async function writeTargetedSettings(root, searchPaths) {
	const settingsPath = path.join(root, "settings.json");
	await writeFile(
		settingsPath,
		JSON.stringify({
			agent: "git-commits-push",
			autoPush: true,
			model: "gpt-5.4-mini",
			provider: "openai",
			searchPaths,
			skipTests: true,
			systemPromptPath: path.join(
				qualification.releaseDirectory,
				"dist",
				"system-prompt.md",
			),
			temperature: 0,
		}),
	);
	return settingsPath;
}

function targetedEnvironment(root, settingsPath, extra) {
	return {
		...isolatedEnvironment(root),
		NODE_ENV: "test",
		OPENAI_API_KEY: SYNTHETIC_API_KEY,
		ORDER_STATE_DIR: path.join(root, "reconciler state"),
		PI_SKILL_STATS_DIR: path.join(root, "telemetry"),
		SECRET_SCANNER_STATS_DIR: path.join(root, "scanner telemetry"),
		TURNLOCK_RUN_DIR_ROOT: path.join(root, "turnlock runs"),
		TURNLOCK_SKILL_SETTINGS_PATH: settingsPath,
		TURNLOCK_TEST: "0",
		...extra,
	};
}

function spawnInstalledLauncher(
	environment,
	argumentsList = [],
	cwd = environment.HOME,
) {
	const child = spawn(qualification.publicExecutablePath, argumentsList, {
		cwd,
		env: environment,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	return { child, stderr: () => stderr, stdout: () => stdout };
}

function targetedArguments(target) {
	return [
		"--repository",
		target.taskPath,
		"--push-remote",
		"origin",
		"--push-ref",
		target.pushRef,
	];
}

/**
 * Two attached linked worktrees of one repository, each on its own branch with
 * the matching remote branch configured as upstream. Used for ordinary
 * invocation isolation and serialization qualification.
 */
async function createLinkedWorktrees(root, environment, baseName) {
	const canonicalRoot = realpathSync(root);
	const searchRoot = path.join(canonicalRoot, `${baseName} search`);
	await mkdir(searchRoot, { recursive: true });
	const repositoryPath = path.join(searchRoot, "repository");
	const bareRemotePath = path.join(canonicalRoot, `${baseName}.git`);
	await createRepoWithBareRemote(repositoryPath, bareRemotePath, environment);
	const baseline = runGit(repositoryPath, ["rev-parse", "HEAD"], environment);
	const worktrees = [];
	for (const name of ["a", "b"]) {
		const branch = `${baseName}-${name}-branch`;
		const worktreePath = path.join(searchRoot, `${name}-worktree`);
		runGit(
			repositoryPath,
			["worktree", "add", worktreePath, "-b", branch, baseline],
			environment,
		);
		runGit(
			repositoryPath,
			["push", "origin", `${branch}:${branch}`],
			environment,
		);
		runGit(
			worktreePath,
			["branch", `--set-upstream-to=origin/${branch}`, branch],
			environment,
		);
		worktrees.push({
			baseline,
			branch,
			pushRef: `refs/heads/${branch}`,
			worktreePath,
		});
	}
	return { bareRemotePath, baseline, repositoryPath, searchRoot, worktrees };
}

/** Stage an ordinary-worktree change inside one linked worktree. */
async function stageWorktreeFile(worktreePath, fileName, environment) {
	await writeFile(
		path.join(worktreePath, fileName),
		`export const ${fileName.replaceAll("-", "_").replaceAll(".", "_")} = true;\n`,
	);
	runGit(worktreePath, ["add", fileName], environment);
}

async function createTargetFixture(root, environment, name) {
	const canonicalRoot = realpathSync(root);
	const searchRoot = path.join(canonicalRoot, `${name} search`);
	await mkdir(searchRoot, { recursive: true });
	const repositoryPath = path.join(searchRoot, "repository");
	const bareRemotePath = path.join(canonicalRoot, `${name}.git`);
	await createRepoWithBareRemote(repositoryPath, bareRemotePath, environment);
	const baseline = runGit(repositoryPath, ["rev-parse", "HEAD"], environment);
	const branch = runGit(
		repositoryPath,
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		environment,
	);
	const taskPath = path.join(searchRoot, "task-worktree");
	runGit(
		repositoryPath,
		["worktree", "add", "--detach", taskPath, baseline],
		environment,
	);
	return {
		bareRemotePath,
		baseline,
		branch,
		pushRef: `refs/heads/${branch}`,
		repositoryPath,
		searchRoot,
		taskPath,
	};
}

async function createIsolationFixture(root, environment, name) {
	const target = await createTargetFixture(root, environment, name);
	await writeFile(
		path.join(target.taskPath, `${name}-task.ts`),
		`export const ${name.replaceAll("-", "_")}Task = true;\n`,
	);
	await writeFile(
		path.join(target.repositoryPath, `${name}-persistent-sentinel.txt`),
		"persistent checkout sentinel\n",
	);
	const siblingRepositoryPath = path.join(target.searchRoot, "sibling");
	const siblingBareRemotePath = path.join(
		realpathSync(root),
		`${name}.sibling.git`,
	);
	await createRepoWithBareRemote(
		siblingRepositoryPath,
		siblingBareRemotePath,
		environment,
	);
	await writeFile(
		path.join(siblingRepositoryPath, `${name}-sibling-sentinel.txt`),
		"sibling repository sentinel\n",
	);
	return {
		...target,
		siblingBareRemotePath,
		siblingRepositoryPath,
	};
}

async function createPushOnlyFixture(root, environment, name) {
	const canonicalRoot = realpathSync(root);
	const searchRoot = path.join(canonicalRoot, `${name} search`);
	await mkdir(searchRoot, { recursive: true });
	const repositoryPath = path.join(searchRoot, "repository");
	const bareRemotePath = path.join(canonicalRoot, `${name}.git`);
	await createRepoWithBareRemote(repositoryPath, bareRemotePath, environment);
	const baselineA = runGit(repositoryPath, ["rev-parse", "HEAD"], environment);
	const branch = runGit(
		repositoryPath,
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		environment,
	);
	await writeFile(
		path.join(repositoryPath, `${name}-state.ts`),
		`export const ${name.replaceAll("-", "_")}State = "B";\n`,
	);
	runGit(repositoryPath, ["add", `${name}-state.ts`], environment);
	runGit(
		repositoryPath,
		["commit", "--quiet", "--no-verify", "-m", `feat: ${name} state`],
		environment,
	);
	const headB = runGit(repositoryPath, ["rev-parse", "HEAD"], environment);
	const taskPath = path.join(searchRoot, "task-worktree");
	runGit(
		repositoryPath,
		["worktree", "add", "--detach", taskPath, headB],
		environment,
	);
	return {
		baselineA,
		bareRemotePath,
		branch,
		headB,
		pushRef: `refs/heads/${branch}`,
		repositoryPath,
		searchRoot,
		taskPath,
	};
}

async function advanceBareRemote(root, target, environment) {
	const clonePath = path.join(
		root,
		`${path.basename(target.bareRemotePath)}-clone`,
	);
	runGit(
		root,
		["clone", "--quiet", target.bareRemotePath, clonePath],
		environment,
	);
	runGit(clonePath, ["config", "user.name", "Advance"], environment);
	runGit(
		clonePath,
		["config", "user.email", "advance@example.invalid"],
		environment,
	);
	await writeFile(
		path.join(clonePath, "advanced.ts"),
		"export const advanced = true;\n",
	);
	runGit(clonePath, ["add", "advanced.ts"], environment);
	runGit(
		clonePath,
		["commit", "--quiet", "--no-verify", "-m", "advance"],
		environment,
	);
	runGit(
		clonePath,
		["push", "--quiet", "origin", `HEAD:${target.pushRef}`],
		environment,
	);
	return runGit(clonePath, ["rev-parse", "HEAD"], environment);
}

function readReconcilerRow(dbPath) {
	const probe = new DatabaseSync(dbPath);
	try {
		return probe
			.prepare(
				"SELECT requested_generation AS requestedGeneration, completed_generation AS completedGeneration, running_generation AS runningGeneration, owner_token AS ownerToken, owner_invocation_mode AS ownerInvocationMode, execution_token AS executionToken, execution_state AS executionState FROM reconciler_state WHERE singleton_id = 1",
			)
			.get();
	} finally {
		probe.close();
	}
}

async function readReconcilerRowEventually(
	dbPath,
	predicate,
	timeoutMs = 90_000,
) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const row = readReconcilerRow(dbPath);
			if (row !== undefined && predicate(row)) return row;
		} catch (error) {
			const message = String(error);
			if (
				!message.includes("database is locked") &&
				!message.includes("no such table: reconciler_state")
			) {
				throw error;
			}
		}
		assert.ok(
			Date.now() < deadline,
			`timed out reading reconciler state at ${dbPath}`,
		);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function observeStableWait(waiter, dbPath, expected) {
	// Observe a real interval: the waiter must stay alive, must not mutate the
	// coordinator row, and must not start any Git-capable execution.
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	assert.strictEqual(waiter.child.exitCode, null, "waiter exited early");
	assert.strictEqual(
		waiter.child.signalCode,
		null,
		"waiter was signalled early",
	);
	const row = readReconcilerRow(dbPath);
	assert.strictEqual(row.requestedGeneration, expected.requestedGeneration);
	assert.strictEqual(row.runningGeneration, expected.runningGeneration);
	assert.strictEqual(row.ownerToken, expected.ownerToken);
	assert.strictEqual(row.executionToken, expected.executionToken);
}

async function readExecutionEvents(eventsPath) {
	if (!existsSync(eventsPath)) return [];
	return (await readFile(eventsPath, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function registeredExecutionTokens(events) {
	return new Set(
		events
			.filter(({ type }) => type === "launcher_execution_registered")
			.map(({ executionToken }) => executionToken),
	);
}

function maximumSimultaneousSupervisorBoundaries(events) {
	const active = new Set();
	let maximum = 0;
	for (const event of events) {
		if (event.type === "supervisor_started") {
			active.add(event.executionToken);
			maximum = Math.max(maximum, active.size);
		}
		if (event.type === "supervisor_exited") {
			active.delete(event.executionToken);
		}
	}
	return maximum;
}

/** Read the single persisted Turnlock state of an ordinary run. */
async function readPersistedRunState(root) {
	const runsRoot = path.join(root, "turnlock runs", "git-commits-push-tl");
	const runEntries = (await readdir(runsRoot, { withFileTypes: true })).filter(
		(entry) => entry.isDirectory(),
	);
	assert.equal(runEntries.length, 1);
	return JSON.parse(
		await readFile(
			path.join(runsRoot, runEntries[0].name, "state.json"),
			"utf8",
		),
	);
}

/** Read the single persisted Turnlock invocation scope of an ordinary run. */
async function readPersistedInvocationScope(root) {
	return (await readPersistedRunState(root)).data.invocationScope;
}

function terminateLauncher(record) {
	if (
		record !== null &&
		record.child.exitCode === null &&
		record.child.signalCode === null
	) {
		record.child.kill("SIGKILL");
	}
}

test("Q1 | installed targeted mode publishes a dirty detached worktree without mutating shared or sibling checkouts", async () => {
	await withAsciiTemporaryDirectory(async (root) => {
		const environment = isolatedEnvironment(root);
		const fixture = await createIsolationFixture(
			root,
			environment,
			"isolation",
		);
		await prepareQualificationRoot(root, environment);
		const settingsPath = await writeTargetedSettings(root, [
			fixture.searchRoot,
		]);
		const requestLogPath = path.join(root, "llm-requests.jsonl");

		const persistentBefore = captureRepositoryState(
			fixture.repositoryPath,
			environment,
		);
		const siblingBefore = captureRepositoryState(
			fixture.siblingRepositoryPath,
			environment,
		);
		const taskBranchesBefore = runGit(
			fixture.repositoryPath,
			["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"],
			environment,
		);
		assert.notEqual(
			tryRunGit(
				fixture.taskPath,
				["symbolic-ref", "--quiet", "--short", "HEAD"],
				environment,
			).status,
			0,
			"WT-A must start detached",
		);
		assert.equal(
			path.resolve(
				fixture.taskPath,
				runGit(
					fixture.taskPath,
					["rev-parse", "--git-common-dir"],
					environment,
				),
			),
			path.resolve(
				fixture.repositoryPath,
				runGit(
					fixture.repositoryPath,
					["rev-parse", "--git-common-dir"],
					environment,
				),
			),
			"WT-A and the persistent checkout must share one Git common directory",
		);

		const launcher = spawnInstalledLauncher(
			targetedEnvironment(root, settingsPath, {
				MOCK_LLM_REQUEST_LOG: requestLogPath,
				NODE_OPTIONS: `--import=${pathToFileURL(reconcilerPreloadPath).href}`,
			}),
			targetedArguments(fixture),
		);
		const exitCode = await waitForClose(launcher.child);
		assert.equal(
			exitCode,
			0,
			`installed targeted launcher failed: ${launcher.stderr()}\n${launcher.stdout()}`,
		);

		const taskHead = runGit(
			fixture.taskPath,
			["rev-parse", "HEAD"],
			environment,
		);
		assert.notEqual(taskHead, fixture.baseline);
		assert.notEqual(
			tryRunGit(
				fixture.taskPath,
				["symbolic-ref", "--quiet", "--short", "HEAD"],
				environment,
			).status,
			0,
			"WT-A must remain detached",
		);
		assert.equal(
			runGit(fixture.taskPath, ["status", "--porcelain=v1"], environment),
			"",
		);
		assert.equal(
			runGit(
				fixture.bareRemotePath,
				["rev-parse", fixture.pushRef],
				environment,
			),
			taskHead,
		);

		// Exact targeted discovery: only the targeted worktree's file was planned.
		const requests = await readJsonLines(requestLogPath);
		const plannedFiles = [
			...new Set(requests.flatMap((request) => request.files ?? [])),
		].sort();
		assert.deepEqual(plannedFiles, ["isolation-task.ts"]);

		// Shared-common-dir isolation and unrelated sibling isolation.
		assert.deepEqual(
			captureRepositoryState(fixture.repositoryPath, environment),
			persistentBefore,
		);
		assert.deepEqual(
			captureRepositoryState(fixture.siblingRepositoryPath, environment),
			siblingBefore,
		);

		// No branch, upstream, push.default, or branch ref mutation.
		assert.deepEqual(
			runGit(
				fixture.repositoryPath,
				["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"],
				environment,
			),
			taskBranchesBefore,
		);
		assert.equal(
			tryRunGit(
				fixture.repositoryPath,
				["config", "--local", "--get", "push.default"],
				environment,
			).status,
			1,
		);
		assert.equal(
			tryRunGit(
				fixture.repositoryPath,
				["config", "--local", "--get-regexp", "^branch\\..*\\.pushremote$"],
				environment,
			).status,
			1,
		);
		assert.match(
			runGit(
				fixture.repositoryPath,
				["worktree", "list", "--porcelain"],
				environment,
			),
			/task-worktree\nHEAD [a-f0-9]{40}\ndetached/,
		);
	});
});

test("Q2 | installed targeted mode publishes a clean detached worktree through the explicit push-only path", async () => {
	await withAsciiTemporaryDirectory(async (root) => {
		const environment = isolatedEnvironment(root);
		const fixture = await createPushOnlyFixture(root, environment, "pushonly");
		await prepareQualificationRoot(root, environment);
		const settingsPath = await writeTargetedSettings(root, [
			fixture.searchRoot,
		]);
		const requestLogPath = path.join(root, "llm-requests.jsonl");

		assert.equal(
			runGit(
				fixture.bareRemotePath,
				["rev-parse", fixture.pushRef],
				environment,
			),
			fixture.baselineA,
		);
		assert.equal(
			runGit(fixture.taskPath, ["rev-parse", "HEAD"], environment),
			fixture.headB,
		);
		assert.equal(
			runGit(fixture.taskPath, ["status", "--porcelain=v1"], environment),
			"",
		);
		assert.equal(
			spawnSync(
				"git",
				["merge-base", "--is-ancestor", fixture.baselineA, fixture.headB],
				{ cwd: fixture.repositoryPath, env: environment, shell: false },
			).status,
			0,
			"A must be a strict ancestor of B",
		);
		const repositoryBefore = captureRepositoryState(
			fixture.repositoryPath,
			environment,
		);
		const taskBefore = captureRepositoryState(fixture.taskPath, environment);

		const launcher = spawnInstalledLauncher(
			targetedEnvironment(root, settingsPath, {
				MOCK_LLM_REQUEST_LOG: requestLogPath,
				NODE_OPTIONS: `--import=${pathToFileURL(reconcilerPreloadPath).href}`,
			}),
			targetedArguments(fixture),
		);
		const exitCode = await waitForClose(launcher.child);
		assert.equal(
			exitCode,
			0,
			`installed targeted launcher failed: ${launcher.stderr()}\n${launcher.stdout()}`,
		);

		assert.equal(
			runGit(fixture.taskPath, ["rev-parse", "HEAD"], environment),
			fixture.headB,
			"push-only must not create a new local commit",
		);
		assert.equal(
			runGit(
				fixture.bareRemotePath,
				["rev-parse", fixture.pushRef],
				environment,
			),
			fixture.headB,
		);
		assert.notEqual(
			tryRunGit(
				fixture.taskPath,
				["symbolic-ref", "--quiet", "--short", "HEAD"],
				environment,
			).status,
			0,
			"WT must remain detached",
		);
		assert.equal(
			runGit(fixture.taskPath, ["status", "--porcelain=v1"], environment),
			"",
		);
		assert.deepEqual(
			captureRepositoryState(fixture.repositoryPath, environment),
			repositoryBefore,
		);
		assert.deepEqual(
			captureRepositoryState(fixture.taskPath, environment),
			taskBefore,
		);

		// The production report proves the explicit push-only path ran and that
		// no commit planning ever reached the LLM boundary.
		assert.match(launcher.stderr(), /existing commit/);
		assert.match(launcher.stderr(), /Exact remote publication verified/);
		assert.deepEqual(await readJsonLines(requestLogPath), []);
	});
});

test("Q3 | installed targeted mode fails closed when the frozen destination moves", async () => {
	await withAsciiTemporaryDirectory(async (root) => {
		const llmServer = await startLlmOverlapServer();
		let launcher = null;
		try {
			const environment = isolatedEnvironment(root);
			const fixture = await createTargetFixture(root, environment, "stale");
			await writeFile(
				path.join(fixture.taskPath, "stale-task.ts"),
				"export const staleTask = true;\n",
			);
			await prepareQualificationRoot(root, environment);
			const settingsPath = await writeTargetedSettings(root, [
				fixture.searchRoot,
			]);

			launcher = spawnInstalledLauncher(
				targetedEnvironment(root, settingsPath, {
					GCP_TEST_LLM_SERVER_URL: llmServer.url,
					NODE_OPTIONS: `--import=${pathToFileURL(overlapPreloadPath).href}`,
				}),
				targetedArguments(fixture),
			);
			await waitForCondition(
				() => llmServer.events.some(({ type }) => type === "request_opened"),
				"installed targeted pass did not reach the LLM barrier",
			);
			const advanced = await advanceBareRemote(root, fixture, environment);
			assert.notEqual(advanced, fixture.baseline);

			llmServer.release();
			const exitCode = await waitForClose(launcher.child);
			assert.notEqual(
				exitCode,
				0,
				`expected a terminal targeted failure, stdout=${launcher.stdout()} stderr=${launcher.stderr()}`,
			);

			const attemptedHead = runGit(
				fixture.taskPath,
				["rev-parse", "HEAD"],
				environment,
			);
			assert.equal(
				runGit(
					fixture.bareRemotePath,
					["rev-parse", fixture.pushRef],
					environment,
				),
				advanced,
			);
			assert.notEqual(advanced, attemptedHead);

			const row = readReconcilerRow(
				path.join(root, "reconciler state", "reconciler.sqlite"),
			);
			assert.equal(row.requestedGeneration, row.completedGeneration);
			assert.equal(row.runningGeneration, null);
			assert.equal(row.ownerInvocationMode, null);
			assert.equal(row.executionToken, null);
			assert.equal(row.executionState, null);

			assert.equal(
				existsSync(resolveGitPath(fixture.taskPath, "MERGE_HEAD", environment)),
				false,
			);
			assert.equal(
				existsSync(
					resolveGitPath(fixture.taskPath, "rebase-merge", environment),
				),
				false,
			);
			assert.equal(
				existsSync(
					resolveGitPath(fixture.taskPath, "rebase-apply", environment),
				),
				false,
			);
			assert.ok(
				runGit(
					fixture.taskPath,
					["rev-list", "--parents", "-n", "1", "HEAD"],
					environment,
				).split(/\s+/u).length <= 2,
				"the targeted HEAD must not be a merge commit",
			);
			assert.match(
				launcher.stderr(),
				/frozen baseline|Remote target moved|diverged/u,
			);
		} finally {
			terminateLauncher(launcher);
			await llmServer.close();
		}
	});
});

test("Q4 | installed targeted mode serializes incompatible requests without scope coalescing", async () => {
	await withAsciiTemporaryDirectory(async (root) => {
		const llmServer = await startLlmOverlapServer();
		let owner = null;
		let waiter = null;
		try {
			const environment = isolatedEnvironment(root);
			const targetA = await createTargetFixture(
				root,
				environment,
				"concurrent-a",
			);
			const targetB = await createTargetFixture(
				root,
				environment,
				"concurrent-b",
			);
			await writeFile(
				path.join(targetA.taskPath, "a-task.ts"),
				"export const aTask = true;\n",
			);
			await writeFile(
				path.join(targetB.taskPath, "b-task.ts"),
				"export const bTask = true;\n",
			);
			await prepareQualificationRoot(root, environment);
			const settingsPath = await writeTargetedSettings(root, [
				targetA.searchRoot,
				targetB.searchRoot,
			]);
			const dbPath = path.join(root, "reconciler state", "reconciler.sqlite");
			const executionEventsPath = path.join(root, "execution-events.jsonl");
			const runtimeExtra = {
				GCP_TEST_EXECUTION_EVENTS_PATH: executionEventsPath,
				GCP_TEST_LLM_SERVER_URL: llmServer.url,
				NODE_OPTIONS: `--import=${pathToFileURL(overlapPreloadPath).href}`,
			};

			owner = spawnInstalledLauncher(
				targetedEnvironment(root, settingsPath, {
					...runtimeExtra,
					PI_SESSION_ID: "installed-targeted-owner-a",
				}),
				targetedArguments(targetA),
			);
			await waitForCondition(
				() =>
					llmServer.events.some(
						(event) =>
							event.type === "request_opened" &&
							(event.payload?.files ?? []).includes("a-task.ts"),
					),
				"installed targeted owner A did not reach the LLM barrier",
			);
			const ownerRequest = llmServer.events.find(
				(event) =>
					event.type === "request_opened" &&
					(event.payload?.files ?? []).includes("a-task.ts"),
			);
			const ownerRow = await readReconcilerRowEventually(
				dbPath,
				(row) => row.executionState === "START_AUTHORIZED",
			);
			assert.equal(ownerRow.ownerInvocationMode, "targeted");
			assert.equal(ownerRow.executionToken, ownerRequest.token);

			waiter = spawnInstalledLauncher(
				targetedEnvironment(root, settingsPath, {
					...runtimeExtra,
					PI_SESSION_ID: "installed-targeted-waiter-b",
				}),
				targetedArguments(targetB),
			);
			await observeStableWait(waiter, dbPath, ownerRow);
			const waitingEvents = await readExecutionEvents(executionEventsPath);
			assert.deepEqual(
				[...registeredExecutionTokens(waitingEvents)],
				[ownerRow.executionToken],
			);
			assert.equal(
				llmServer.events.some(
					(event) =>
						event.type === "request_opened" &&
						(event.payload?.files ?? []).includes("b-task.ts"),
				),
				false,
				"the waiting targeted scope must not execute",
			);
			assert.equal(
				runGit(
					targetB.bareRemotePath,
					["rev-parse", targetB.pushRef],
					environment,
				),
				targetB.baseline,
			);
			assert.equal(
				runGit(targetB.taskPath, ["rev-parse", "HEAD"], environment),
				targetB.baseline,
			);
			assert.notEqual(
				runGit(targetB.taskPath, ["status", "--porcelain=v1"], environment),
				"",
			);

			llmServer.release();
			assert.equal(await waitForClose(owner.child), 0, owner.stderr());
			assert.equal(await waitForClose(waiter.child), 0, waiter.stderr());

			const finalRow = readReconcilerRow(dbPath);
			assert.equal(finalRow.requestedGeneration, 2);
			assert.equal(finalRow.completedGeneration, 2);
			assert.equal(finalRow.runningGeneration, null);
			assert.equal(finalRow.ownerToken, null);
			assert.equal(finalRow.ownerInvocationMode, null);
			assert.equal(finalRow.executionToken, null);

			const headA = runGit(
				targetA.taskPath,
				["rev-parse", "HEAD"],
				environment,
			);
			const headB = runGit(
				targetB.taskPath,
				["rev-parse", "HEAD"],
				environment,
			);
			assert.notEqual(headA, targetA.baseline);
			assert.notEqual(headB, targetB.baseline);
			assert.notEqual(headA, headB);
			assert.equal(
				runGit(
					targetA.bareRemotePath,
					["rev-parse", targetA.pushRef],
					environment,
				),
				headA,
			);
			assert.equal(
				runGit(
					targetB.bareRemotePath,
					["rev-parse", targetB.pushRef],
					environment,
				),
				headB,
			);

			const treeA = runGit(
				targetA.bareRemotePath,
				["ls-tree", "-r", "--name-only", headA],
				environment,
			).split("\n");
			const treeB = runGit(
				targetB.bareRemotePath,
				["ls-tree", "-r", "--name-only", headB],
				environment,
			).split("\n");
			assert.equal(treeA.includes("a-task.ts"), true);
			assert.equal(treeA.includes("b-task.ts"), false);
			assert.equal(treeB.includes("b-task.ts"), true);
			assert.equal(treeB.includes("a-task.ts"), false);

			const events = await readExecutionEvents(executionEventsPath);
			const supervisorTokens = new Set(
				events
					.filter(({ type }) => type === "supervisor_started")
					.map(({ executionToken }) => executionToken),
			);
			assert.equal(supervisorTokens.size, 2);
			assert.equal(maximumSimultaneousSupervisorBoundaries(events), 1);
			assert.equal(llmServer.overlapDetected(), false);
			assert.equal(llmServer.maximumActiveExecutions(), 1);
		} finally {
			terminateLauncher(owner);
			terminateLauncher(waiter);
			await llmServer.close();
		}
	});
});

test("Q5 | installed ordinary invocation resolves nested cwd to its exact worktree and isolates siblings", async () => {
	await withAsciiTemporaryDirectory(async (root) => {
		const environment = isolatedEnvironment(root);
		const linked = await createLinkedWorktrees(root, environment, "nested");
		const worktreeA = linked.worktrees[0];
		const worktreeB = linked.worktrees[1];
		await stageWorktreeFile(worktreeA.worktreePath, "a-task.ts", environment);
		await stageWorktreeFile(worktreeB.worktreePath, "b-task.ts", environment);
		const unrelatedRepository = path.join(
			realpathSync(root),
			"unrelated search",
			"repository",
		);
		await createRepoWithBareRemote(
			unrelatedRepository,
			path.join(realpathSync(root), "unrelated.git"),
			environment,
		);
		await writeFile(
			path.join(unrelatedRepository, "c-task.ts"),
			"export const cTask = true;\n",
		);
		runGit(unrelatedRepository, ["add", "c-task.ts"], environment);

		await prepareQualificationRoot(root, environment);
		const settingsPath = await writeTargetedSettings(root, [
			realpathSync(root),
		]);
		const requestLogPath = path.join(root, "llm-requests.jsonl");
		const nestedDirectory = path.join(
			worktreeA.worktreePath,
			"nested",
			"deeper",
		);
		await mkdir(nestedDirectory, { recursive: true });

		const siblingBefore = captureRepositoryState(
			worktreeB.worktreePath,
			environment,
			[worktreeA.pushRef],
		);
		const unrelatedBefore = captureRepositoryState(
			unrelatedRepository,
			environment,
		);

		// The inherited poisoned value must never override the real process cwd.
		const launcher = spawnInstalledLauncher(
			targetedEnvironment(root, settingsPath, {
				GCP_INVOCATION_CWD: worktreeB.worktreePath,
				MOCK_LLM_REQUEST_LOG: requestLogPath,
				NODE_OPTIONS: `--import=${pathToFileURL(reconcilerPreloadPath).href}`,
			}),
			[],
			nestedDirectory,
		);
		const exitCode = await waitForClose(launcher.child);
		assert.equal(
			exitCode,
			0,
			`installed ordinary launcher failed: ${launcher.stderr()}\n${launcher.stdout()}`,
		);

		// A published to its own tracked branch from the nested invocation cwd.
		const headA = runGit(
			worktreeA.worktreePath,
			["rev-parse", "HEAD"],
			environment,
		);
		assert.notEqual(headA, worktreeA.baseline);
		assert.equal(
			runGit(worktreeA.worktreePath, ["status", "--porcelain=v1"], environment),
			"",
		);
		assert.equal(
			runGit(
				worktreeA.worktreePath,
				["symbolic-ref", "--quiet", "--short", "HEAD"],
				environment,
			),
			worktreeA.branch,
		);
		assert.equal(
			runGit(
				linked.bareRemotePath,
				["rev-parse", worktreeA.pushRef],
				environment,
			),
			headA,
		);

		// Only A reached the LLM boundary; no B or C file appears in A's payload.
		const requests = await readJsonLines(requestLogPath);
		assert.equal(requests.length, 1);
		const persistedRunState = await readPersistedRunState(root);
		assert.deepEqual(
			Object.values(persistedRunState.data.repos).map(
				(repo) => repo.repository,
			),
			[realpathSync(worktreeA.worktreePath)],
		);
		const plannedFiles = [
			...new Set(requests.flatMap((request) => request.files ?? [])),
		].sort();
		assert.deepEqual(plannedFiles, ["a-task.ts"]);
		const requestText = JSON.stringify(requests);
		assert.equal(requestText.includes("b-task.ts"), false);
		assert.equal(requestText.includes("c-task.ts"), false);

		// B and the unrelated repository remain byte-for-byte unchanged. B's
		// own branch and remote-tracking refs are asserted separately because
		// the linked worktrees share the ref store with A's own branch.
		assert.equal(
			runGit(
				worktreeB.worktreePath,
				["rev-parse", worktreeB.pushRef],
				environment,
			),
			worktreeB.baseline,
		);
		assert.equal(
			runGit(
				worktreeB.worktreePath,
				["rev-parse", `refs/remotes/origin/${worktreeB.branch}`],
				environment,
			),
			worktreeB.baseline,
		);
		assert.deepEqual(
			captureRepositoryState(worktreeB.worktreePath, environment, [
				worktreeA.pushRef,
			]),
			siblingBefore,
		);
		assert.deepEqual(
			captureRepositoryState(unrelatedRepository, environment),
			unrelatedBefore,
		);

		// The persisted scope is canonical worktree A, never the poisoned value.
		assert.deepEqual(await readPersistedInvocationScope(root), {
			kind: "worktree",
			repository: realpathSync(worktreeA.worktreePath),
		});
	});
});

test("Q6 | installed ordinary invocation from a clean worktree does not fall through to a dirty sibling", async () => {
	await withAsciiTemporaryDirectory(async (root) => {
		const environment = isolatedEnvironment(root);
		const linked = await createLinkedWorktrees(root, environment, "clean");
		const worktreeA = linked.worktrees[0];
		const worktreeB = linked.worktrees[1];
		await stageWorktreeFile(worktreeB.worktreePath, "b-task.ts", environment);

		await prepareQualificationRoot(root, environment);
		const settingsPath = await writeTargetedSettings(root, [
			realpathSync(root),
		]);
		const requestLogPath = path.join(root, "llm-requests.jsonl");
		const siblingBefore = captureRepositoryState(
			worktreeB.worktreePath,
			environment,
		);

		const launcher = spawnInstalledLauncher(
			targetedEnvironment(root, settingsPath, {
				MOCK_LLM_REQUEST_LOG: requestLogPath,
				NODE_OPTIONS: `--import=${pathToFileURL(reconcilerPreloadPath).href}`,
			}),
			[],
			worktreeA.worktreePath,
		);
		const exitCode = await waitForClose(launcher.child);
		assert.equal(
			exitCode,
			0,
			`installed ordinary launcher failed: ${launcher.stderr()}\n${launcher.stdout()}`,
		);
		assert.match(launcher.stderr(), /No repositories with changes found/);

		assert.deepEqual(await readJsonLines(requestLogPath), []);
		assert.deepEqual(
			captureRepositoryState(worktreeB.worktreePath, environment),
			siblingBefore,
		);
		assert.equal(
			runGit(
				linked.bareRemotePath,
				["rev-parse", worktreeB.pushRef],
				environment,
			),
			worktreeB.baseline,
		);
		assert.deepEqual(await readPersistedInvocationScope(root), {
			kind: "worktree",
			repository: realpathSync(worktreeA.worktreePath),
		});
	});
});

test("Q7 | installed ordinary invocations from different worktrees serialize without coalescing", async () => {
	await withAsciiTemporaryDirectory(async (root) => {
		const llmServer = await startLlmOverlapServer();
		let owner = null;
		let waiter = null;
		try {
			const environment = isolatedEnvironment(root);
			const linked = await createLinkedWorktrees(
				root,
				environment,
				"concurrent",
			);
			const worktreeA = linked.worktrees[0];
			const worktreeB = linked.worktrees[1];
			await stageWorktreeFile(worktreeA.worktreePath, "a-task.ts", environment);
			await stageWorktreeFile(worktreeB.worktreePath, "b-task.ts", environment);
			await prepareQualificationRoot(root, environment);
			const settingsPath = await writeTargetedSettings(root, [
				realpathSync(root),
			]);
			const dbPath = path.join(root, "reconciler state", "reconciler.sqlite");
			const executionEventsPath = path.join(root, "execution-events.jsonl");
			const runtimeExtra = {
				GCP_TEST_EXECUTION_EVENTS_PATH: executionEventsPath,
				GCP_TEST_LLM_SERVER_URL: llmServer.url,
				NODE_OPTIONS: `--import=${pathToFileURL(overlapPreloadPath).href}`,
			};
			const siblingBefore = captureRepositoryState(
				worktreeB.worktreePath,
				environment,
			);

			owner = spawnInstalledLauncher(
				targetedEnvironment(root, settingsPath, {
					...runtimeExtra,
					PI_SESSION_ID: "installed-ordinary-owner-a",
				}),
				[],
				worktreeA.worktreePath,
			);
			await waitForCondition(
				() =>
					llmServer.events.some(
						(event) =>
							event.type === "request_opened" &&
							(event.payload?.files ?? []).includes("a-task.ts"),
					),
				"installed ordinary owner A did not reach the LLM barrier",
			);
			const ownerRow = await readReconcilerRowEventually(
				dbPath,
				(row) => row.executionState === "START_AUTHORIZED",
			);
			assert.equal(ownerRow.ownerInvocationMode, "targeted");

			waiter = spawnInstalledLauncher(
				targetedEnvironment(root, settingsPath, {
					...runtimeExtra,
					PI_SESSION_ID: "installed-ordinary-waiter-b",
				}),
				[],
				worktreeB.worktreePath,
			);
			await observeStableWait(waiter, dbPath, ownerRow);
			const waitingEvents = await readExecutionEvents(executionEventsPath);
			assert.deepEqual(
				[...registeredExecutionTokens(waitingEvents)],
				[ownerRow.executionToken],
			);
			assert.equal(
				llmServer.events.some(
					(event) =>
						event.type === "request_opened" &&
						(event.payload?.files ?? []).includes("b-task.ts"),
				),
				false,
				"the waiting ordinary scope must not execute",
			);
			// B carries no durable generation and remains unchanged while waiting.
			assert.equal(
				readReconcilerRow(dbPath).requestedGeneration,
				ownerRow.requestedGeneration,
			);
			assert.deepEqual(
				captureRepositoryState(worktreeB.worktreePath, environment),
				siblingBefore,
			);

			llmServer.release();
			assert.equal(await waitForClose(owner.child), 0, owner.stderr());
			assert.equal(await waitForClose(waiter.child), 0, waiter.stderr());

			const finalRow = readReconcilerRow(dbPath);
			assert.equal(finalRow.requestedGeneration, 2);
			assert.equal(finalRow.completedGeneration, 2);
			assert.equal(finalRow.runningGeneration, null);
			assert.equal(finalRow.ownerToken, null);
			assert.equal(finalRow.ownerInvocationMode, null);
			assert.equal(finalRow.executionToken, null);

			const headA = runGit(
				worktreeA.worktreePath,
				["rev-parse", "HEAD"],
				environment,
			);
			const headB = runGit(
				worktreeB.worktreePath,
				["rev-parse", "HEAD"],
				environment,
			);
			assert.notEqual(headA, worktreeA.baseline);
			assert.notEqual(headB, worktreeB.baseline);
			assert.notEqual(headA, headB);
			assert.equal(
				runGit(
					linked.bareRemotePath,
					["rev-parse", worktreeA.pushRef],
					environment,
				),
				headA,
			);
			assert.equal(
				runGit(
					linked.bareRemotePath,
					["rev-parse", worktreeB.pushRef],
					environment,
				),
				headB,
			);

			const treeA = runGit(
				linked.bareRemotePath,
				["ls-tree", "-r", "--name-only", headA],
				environment,
			).split("\n");
			const treeB = runGit(
				linked.bareRemotePath,
				["ls-tree", "-r", "--name-only", headB],
				environment,
			).split("\n");
			assert.equal(treeA.includes("a-task.ts"), true);
			assert.equal(treeA.includes("b-task.ts"), false);
			assert.equal(treeB.includes("b-task.ts"), true);
			assert.equal(treeB.includes("a-task.ts"), false);

			const events = await readExecutionEvents(executionEventsPath);
			const supervisorTokens = new Set(
				events
					.filter(({ type }) => type === "supervisor_started")
					.map(({ executionToken }) => executionToken),
			);
			assert.equal(supervisorTokens.size, 2);
			assert.equal(maximumSimultaneousSupervisorBoundaries(events), 1);
			assert.equal(llmServer.overlapDetected(), false);
			assert.equal(llmServer.maximumActiveExecutions(), 1);
		} finally {
			terminateLauncher(owner);
			terminateLauncher(waiter);
			await llmServer.close();
		}
	});
});

test("Q8 | installed repeated ordinary invocation from the same worktree serializes safely", async () => {
	await withAsciiTemporaryDirectory(async (root) => {
		const llmServer = await startLlmOverlapServer();
		let first = null;
		let second = null;
		try {
			const environment = isolatedEnvironment(root);
			const linked = await createLinkedWorktrees(root, environment, "repeated");
			const worktreeA = linked.worktrees[0];
			await stageWorktreeFile(worktreeA.worktreePath, "a-task.ts", environment);
			await prepareQualificationRoot(root, environment);
			const settingsPath = await writeTargetedSettings(root, [
				realpathSync(root),
			]);
			const dbPath = path.join(root, "reconciler state", "reconciler.sqlite");
			const executionEventsPath = path.join(root, "execution-events.jsonl");
			const runtimeExtra = {
				GCP_TEST_EXECUTION_EVENTS_PATH: executionEventsPath,
				GCP_TEST_LLM_SERVER_URL: llmServer.url,
				NODE_OPTIONS: `--import=${pathToFileURL(overlapPreloadPath).href}`,
			};

			first = spawnInstalledLauncher(
				targetedEnvironment(root, settingsPath, {
					...runtimeExtra,
					PI_SESSION_ID: "installed-repeat-first",
				}),
				[],
				worktreeA.worktreePath,
			);
			await waitForCondition(
				() =>
					llmServer.events.some(
						(event) =>
							event.type === "request_opened" &&
							(event.payload?.files ?? []).includes("a-task.ts"),
					),
				"installed repeated first pass did not reach the LLM barrier",
			);
			const firstRow = await readReconcilerRowEventually(
				dbPath,
				(row) => row.executionState === "START_AUTHORIZED",
			);
			assert.equal(firstRow.ownerInvocationMode, "targeted");

			second = spawnInstalledLauncher(
				targetedEnvironment(root, settingsPath, {
					...runtimeExtra,
					PI_SESSION_ID: "installed-repeat-second",
				}),
				[],
				worktreeA.worktreePath,
			);
			await observeStableWait(second, dbPath, firstRow);
			const waitingEvents = await readExecutionEvents(executionEventsPath);
			assert.deepEqual(
				[...registeredExecutionTokens(waitingEvents)],
				[firstRow.executionToken],
			);
			assert.equal(
				readReconcilerRow(dbPath).requestedGeneration,
				firstRow.requestedGeneration,
			);

			llmServer.release();
			assert.equal(await waitForClose(first.child), 0, first.stderr());
			assert.equal(await waitForClose(second.child), 0, second.stderr());

			const finalRow = readReconcilerRow(dbPath);
			assert.equal(finalRow.requestedGeneration, 2);
			assert.equal(finalRow.completedGeneration, 2);
			assert.equal(finalRow.runningGeneration, null);
			assert.equal(finalRow.ownerToken, null);

			const headA = runGit(
				worktreeA.worktreePath,
				["rev-parse", "HEAD"],
				environment,
			);
			assert.notEqual(headA, worktreeA.baseline);
			assert.equal(
				runGit(
					worktreeA.worktreePath,
					["status", "--porcelain=v1"],
					environment,
				),
				"",
			);
			assert.equal(
				runGit(
					linked.bareRemotePath,
					["rev-parse", worktreeA.pushRef],
					environment,
				),
				headA,
			);

			// The second exact request observed the clean worktree: no new LLM work.
			assert.equal(
				llmServer.events.filter(({ type }) => type === "request_opened").length,
				1,
			);

			const events = await readExecutionEvents(executionEventsPath);
			const supervisorTokens = new Set(
				events
					.filter(({ type }) => type === "supervisor_started")
					.map(({ executionToken }) => executionToken),
			);
			assert.equal(supervisorTokens.size, 2);
			assert.equal(maximumSimultaneousSupervisorBoundaries(events), 1);
			assert.equal(llmServer.overlapDetected(), false);
			assert.equal(llmServer.maximumActiveExecutions(), 1);
		} finally {
			terminateLauncher(first);
			terminateLauncher(second);
			await llmServer.close();
		}
	});
});
