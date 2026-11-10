import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { copyDeploymentSource } from "./deployment-source.mjs";
import { resolvePathExecutable } from "./path-executable.mjs";
import { resolvePnpmOfflineEnvironment } from "./pnpm-offline-environment.mjs";
import {
	createRepoWithBareRemote,
	isolatedEnvironment,
	runGit,
	waitForClose,
} from "./reconciler-e2e-helpers.mjs";

const repository = path.resolve(import.meta.dirname, "../../..");
const preload = pathToFileURL(
	path.join(import.meta.dirname, "mock-openai-fetch-reconciler.mjs"),
).href;

/** Existing production installer, deployed only into a task-owned isolated HOME/XDG. */
export async function installCreateQualification() {
	const root = realpathSync(
		await mkdtemp(path.join(tmpdir(), "gcp-create-candidate-")),
	);
	const { installStandalone } = await import(
		pathToFileURL(
			path.join(
				repository,
				"dist/src/modules/installation/standalone-installer.js",
			),
		).href
	);
	const pnpmCliPath =
		process.env.npm_execpath ?? (await resolvePathExecutable("pnpm"));
	const deploymentSource = path.join(root, "deployment-source");
	await copyDeploymentSource(repository, deploymentSource);
	const installation = await installStandalone({
		sourceDirectory: deploymentSource,
		pnpmCliPath,
		homeDirectory: path.join(root, "home"),
		environment: {
			...resolvePnpmOfflineEnvironment(pnpmCliPath, repository),
			XDG_DATA_HOME: path.join(root, "data"),
		},
	});
	await rm(deploymentSource, { recursive: true });
	assert.match(installation.releaseName, /^0\.11\.1-[a-f0-9]{64}$/u);
	const manifest = JSON.parse(
		await readFile(
			path.join(installation.releaseDirectory, "package.json"),
			"utf8",
		),
	);
	assert.equal(manifest.version, "0.11.1");
	assert.equal(
		await realpath(installation.paths.publicExecutablePath),
		path.join(installation.releaseDirectory, "bin/git-commits-push.mjs"),
	);
	process.stdout.write(
		`Candidate isolated release: ${installation.releaseName}\n`,
	);
	return {
		...installation,
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

export async function withCreateFixture(installation, callback) {
	const temp = await mkdtemp(path.join(tmpdir(), "gcp-create-installed-"));
	const root = realpathSync(temp);
	try {
		const env = {
			...isolatedEnvironment(root),
			NODE_ENV: "test",
			TURNLOCK_TEST: "0",
			OPENAI_API_KEY: `sk-${"Q".repeat(48)}`,
			NODE_OPTIONS: `--import=${preload}`,
			ORDER_STATE_DIR: path.join(root, "orders"),
			TURNLOCK_RUN_DIR_ROOT: path.join(root, "runs"),
			PI_SKILL_STATS_DIR: path.join(root, "stats"),
			SECRET_SCANNER_STATS_DIR: path.join(root, "stats"),
			MOCK_LLM_REQUEST_LOG: path.join(root, "requests.jsonl"),
		};
		await mkdir(env.HOME, { recursive: true });
		await mkdir(env.XDG_CONFIG_HOME, { recursive: true });
		const settingsPath = path.join(root, "settings.json");
		const settings = {
			searchPaths: [],
			provider: "openai",
			model: "gpt-5.4-mini",
			temperature: 0,
			autoPush: false,
			skipTests: true,
			systemPromptPath: path.join(
				installation.releaseDirectory,
				"dist/system-prompt.md",
			),
		};
		await writeFile(settingsPath, JSON.stringify(settings));
		env.TURNLOCK_SKILL_SETTINGS_PATH = settingsPath;
		// Preserve the host's supported Node launcher (including compatibility shims)
		// while proving that pnpm is unavailable to the installed runtime.
		const runtimeBin = path.join(root, "runtime-bin");
		await mkdir(runtimeBin);
		await symlink(
			await resolvePathExecutable("node"),
			path.join(runtimeBin, "node"),
		);
		await symlink(
			await resolvePathExecutable("git"),
			path.join(runtimeBin, "git"),
		);
		env.PATH = `${runtimeBin}:/usr/bin:/bin:/usr/sbin:/sbin`;
		const persistent = path.join(root, "persistent");
		const remote = path.join(root, "remote.git");
		await createRepoWithBareRemote(persistent, remote, env);
		const B = runGit(persistent, ["rev-parse", "HEAD"], env);
		const baseRef = runGit(persistent, ["symbolic-ref", "HEAD"], env);
		const worktree = path.join(root, "task");
		runGit(persistent, ["worktree", "add", "--detach", worktree, B], env);
		const scope = {
			kind: "targeted-create",
			repository: worktree,
			pushRemote: "origin",
			pushRef: "refs/heads/task",
			baseRef,
			baseSha: B,
		};
		const args = [
			"--repository",
			worktree,
			"--push-remote",
			"origin",
			"--push-ref",
			scope.pushRef,
			"--create-if-absent",
			"--base-ref",
			baseRef,
			"--base-sha",
			B,
		];
		await callback({
			root,
			env,
			settings,
			persistent,
			remote,
			worktree,
			B,
			baseRef,
			scope,
			args,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** Run the genuinely installed stable public launcher, not a source entrypoint. */
export function startInstalled(
	installation,
	fixture,
	args = fixture.args,
	extra = {},
) {
	const child = spawn(installation.paths.publicExecutablePath, args, {
		cwd: fixture.env.HOME,
		env: { ...fixture.env, ...extra },
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (data) => {
		output += data.toString();
	});
	child.stderr.on("data", (data) => {
		output += data.toString();
	});
	return {
		child,
		output: () => output,
		done: async () => ({ code: await waitForClose(child), output }),
	};
}
