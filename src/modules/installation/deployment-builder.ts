import { spawn } from "node:child_process";
import { chmod, lstat, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { requireAbsolutePath } from "./install-paths.ts";
import { requireStandalonePackageVersion } from "./release-identity.ts";
import { digestReleaseTree, validateReleaseTree } from "./release-tree.ts";

const REQUIRED_RELEASE_FILES = [
	"bin/git-commits-push.mjs",
	"dist/src/entrypoints/git-commits-push.js",
	"dist/src/entrypoints/node-supervisor.js",
	"dist/src/entrypoints/turnlock-orchestrator.js",
	"dist/src/entrypoints/turnlock-to-llm-bridge.js",
	"dist/src/config/settings.json",
	"dist/system-prompt.md",
	"node_modules/@git-commits-push/node-runtime/dist/index.js",
	"node_modules/@git-commits-push/trust/dist/index.js",
] as const;

interface DeployedManifest {
	readonly name?: unknown;
	readonly version?: unknown;
}

export interface BuildStandaloneDeploymentOptions {
	readonly environment: NodeJS.ProcessEnv;
	readonly pnpmCliPath: string;
	readonly sourceDirectory: string;
	readonly targetDirectory: string;
}

export interface BuiltStandaloneDeployment {
	readonly digest: string;
	readonly version: string;
}

async function runPnpmDeploy(
	options: BuildStandaloneDeploymentOptions,
): Promise<void> {
	requireAbsolutePath(options.pnpmCliPath, "pnpm CLI path");
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				options.pnpmCliPath,
				"--filter",
				"git-commits-push",
				"deploy",
				"--prod",
				options.targetDirectory,
			],
			{
				cwd: options.sourceDirectory,
				env: options.environment,
				shell: false,
				stdio: "inherit",
			},
		);
		child.once("error", reject);
		child.once("close", (exitCode, signal) => {
			if (exitCode === 0 && signal === null) resolve();
			else {
				reject(
					new Error(
						`pnpm deploy failed${signal ? ` with ${signal}` : ` with exit code ${String(exitCode)}`}.`,
					),
				);
			}
		});
	});
}

async function removePnpmMetadata(releaseDirectory: string): Promise<void> {
	const nodeModulesDirectory = path.join(releaseDirectory, "node_modules");
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory() && entry.name === ".bin") {
				await rm(entryPath, { force: true, recursive: true });
			} else if (entry.isDirectory()) {
				await visit(entryPath);
			}
		}
	}
	await visit(nodeModulesDirectory);
	for (const metadataPath of [
		"pnpm-lock.yaml",
		"node_modules/.modules.yaml",
		"node_modules/.package-map.json",
		"node_modules/.pnpm-workspace-state-v1.json",
		"node_modules/.pnpm/lock.yaml",
	]) {
		await rm(path.join(releaseDirectory, metadataPath), { force: true });
	}
}

async function validateDeployedApplication(
	releaseDirectory: string,
): Promise<string> {
	const manifest: DeployedManifest = JSON.parse(
		await readFile(path.join(releaseDirectory, "package.json"), "utf8"),
	);
	if (manifest.name !== "git-commits-push") {
		throw new Error("Deployed package manifest is invalid.");
	}
	const version = requireStandalonePackageVersion(manifest.version);
	const executablePath = path.join(
		releaseDirectory,
		"bin",
		"git-commits-push.mjs",
	);
	await chmod(executablePath, 0o755);
	for (const relativePath of REQUIRED_RELEASE_FILES) {
		const requiredPath = path.join(releaseDirectory, relativePath);
		const stats = await lstat(requiredPath);
		if (!stats.isFile()) {
			throw new Error(
				`Deployed release artifact is not a file: ${relativePath}`,
			);
		}
	}
	await validateReleaseTree(releaseDirectory);
	return version;
}

/** Build and fully verify one self-contained deployment in a staging directory. */
export async function buildStandaloneDeployment(
	options: BuildStandaloneDeploymentOptions,
): Promise<BuiltStandaloneDeployment> {
	await runPnpmDeploy(options);
	await removePnpmMetadata(options.targetDirectory);
	const version = await validateDeployedApplication(options.targetDirectory);
	return {
		digest: await digestReleaseTree(options.targetDirectory),
		version,
	};
}
