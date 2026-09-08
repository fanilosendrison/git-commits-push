import { randomBytes } from "node:crypto";
import {
	lstat,
	mkdir,
	readdir,
	readlink,
	realpath,
	rename,
	rm,
	symlink,
} from "node:fs/promises";
import path from "node:path";
import { buildStandaloneDeployment } from "./deployment-builder.ts";
import { acquireInstallLock, releaseInstallLock } from "./install-lock.ts";
import {
	type ResolveStandaloneInstallPathsOptions,
	requireAbsolutePath,
	resolveStandaloneInstallPaths,
	type StandaloneInstallPaths,
} from "./install-paths.ts";
import {
	createStandaloneReleaseName,
	isStandaloneReleaseName,
} from "./release-identity.ts";
import { digestReleaseTree } from "./release-tree.ts";

export {
	resolveStandaloneInstallPaths,
	type StandaloneInstallPaths,
} from "./install-paths.ts";

export interface InstallStandaloneOptions
	extends ResolveStandaloneInstallPathsOptions {
	readonly pnpmCliPath: string;
	readonly sourceDirectory: string;
}

export interface InstallStandaloneResult {
	readonly paths: StandaloneInstallPaths;
	readonly releaseDirectory: string;
	readonly releaseName: string;
	readonly reusedRelease: boolean;
}

function hasExpectedOwner(uid: number): boolean {
	return process.getuid === undefined || uid === process.getuid();
}

async function ensurePhysicalDirectory(
	directory: string,
	mode: number,
): Promise<void> {
	await mkdir(directory, { mode, recursive: true });
	const stats = await lstat(directory);
	if (
		!stats.isDirectory() ||
		stats.isSymbolicLink() ||
		!hasExpectedOwner(stats.uid)
	) {
		throw new Error(
			`Install path must be an owned physical directory: ${directory}`,
		);
	}
}

async function pathKind(
	candidate: string,
): Promise<"absent" | "directory" | "symlink" | "other"> {
	try {
		const stats = await lstat(candidate);
		if (stats.isSymbolicLink()) return "symlink";
		if (stats.isDirectory()) return "directory";
		return "other";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
		throw error;
	}
}

async function removeStaleStagingDirectories(
	releasesDirectory: string,
): Promise<void> {
	for (const entry of await readdir(releasesDirectory, {
		withFileTypes: true,
	})) {
		if (!/^\.staging-[a-f0-9]{32}$/.test(entry.name)) continue;
		const stalePath = path.join(releasesDirectory, entry.name);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(
				`Stale staging entry is not a physical directory: ${stalePath}`,
			);
		}
		await rm(stalePath, { force: true, recursive: true });
	}
}

async function verifyExistingRelease(
	releaseDirectory: string,
	expectedDigest: string,
): Promise<void> {
	if ((await pathKind(releaseDirectory)) !== "directory") {
		throw new Error(
			`Content-addressed release path is not a directory: ${releaseDirectory}`,
		);
	}
	const observedDigest = await digestReleaseTree(releaseDirectory);
	if (observedDigest !== expectedDigest) {
		throw new Error(
			`Content-addressed release failed digest verification: ${releaseDirectory}`,
		);
	}
}

function isReleaseTarget(target: string): boolean {
	const normalized = target.split(path.sep).join("/");
	const prefix = "releases/";
	return (
		normalized.startsWith(prefix) &&
		isStandaloneReleaseName(normalized.slice(prefix.length))
	);
}

async function replaceCurrentReleaseLink(
	paths: StandaloneInstallPaths,
	releaseName: string,
): Promise<void> {
	const currentKind = await pathKind(paths.currentReleaseLink);
	if (currentKind !== "absent" && currentKind !== "symlink") {
		throw new Error(
			`Current release entry must be a symlink or absent: ${paths.currentReleaseLink}`,
		);
	}
	if (currentKind === "symlink") {
		const currentTarget = await readlink(paths.currentReleaseLink);
		if (!isReleaseTarget(currentTarget)) {
			throw new Error(
				`Current release symlink has an unsafe target: ${currentTarget}`,
			);
		}
	}
	const temporaryLink = `${paths.currentReleaseLink}.next-${randomBytes(8).toString("hex")}`;
	try {
		await symlink(path.join("releases", releaseName), temporaryLink);
		await rename(temporaryLink, paths.currentReleaseLink);
	} finally {
		await rm(temporaryLink, { force: true });
	}
}

async function ensureStablePublicExecutable(
	paths: StandaloneInstallPaths,
): Promise<void> {
	const expectedTarget = path.relative(
		path.dirname(paths.publicExecutablePath),
		path.join(paths.currentReleaseLink, "bin", "git-commits-push.mjs"),
	);
	const publicKind = await pathKind(paths.publicExecutablePath);
	if (publicKind === "symlink") {
		const observedTarget = await readlink(paths.publicExecutablePath);
		if (observedTarget !== expectedTarget) {
			throw new Error(
				`Public executable points to an unexpected target: ${observedTarget}`,
			);
		}
		return;
	}
	if (publicKind !== "absent") {
		throw new Error(
			`Public executable path must be absent or the managed symlink: ${paths.publicExecutablePath}`,
		);
	}
	try {
		await symlink(expectedTarget, paths.publicExecutablePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(
				`Public executable path changed during installation: ${paths.publicExecutablePath}`,
				{ cause: error },
			);
		}
		throw error;
	}
}

/** Atomically activate an already verified immutable release. */
export async function activateStandaloneRelease(
	paths: StandaloneInstallPaths,
	releaseName: string,
): Promise<void> {
	if (!isStandaloneReleaseName(releaseName)) {
		throw new Error(`Invalid standalone release name: ${releaseName}`);
	}
	const releaseDirectory = path.join(paths.releasesDirectory, releaseName);
	const releaseExecutable = path.join(
		releaseDirectory,
		"bin",
		"git-commits-push.mjs",
	);
	if (!(await lstat(releaseExecutable)).isFile()) {
		throw new Error(`Release executable is not a file: ${releaseExecutable}`);
	}
	await ensurePhysicalDirectory(
		path.dirname(paths.publicExecutablePath),
		0o755,
	);
	await ensureStablePublicExecutable(paths);
	await replaceCurrentReleaseLink(paths, releaseName);
	const activeExecutable = await realpath(paths.publicExecutablePath);
	if (activeExecutable !== (await realpath(releaseExecutable))) {
		throw new Error(
			"Activated executable does not resolve to the requested release.",
		);
	}
}

/** Deploy, verify, content-address and atomically activate the standalone CLI. */
export async function installStandalone(
	options: InstallStandaloneOptions,
): Promise<InstallStandaloneResult> {
	const sourceDirectory = requireAbsolutePath(
		options.sourceDirectory,
		"Source directory",
	);
	const environment = options.environment ?? process.env;
	const paths = resolveStandaloneInstallPaths(options);
	await ensurePhysicalDirectory(
		path.dirname(paths.publicExecutablePath),
		0o755,
	);
	await ensurePhysicalDirectory(paths.applicationDirectory, 0o700);
	await ensurePhysicalDirectory(paths.releasesDirectory, 0o700);
	const lockOwner = acquireInstallLock(paths.installLockPath);
	const stagingDirectory = path.join(
		paths.releasesDirectory,
		`.staging-${randomBytes(16).toString("hex")}`,
	);
	let operationResult: InstallStandaloneResult | null = null;
	let operationFailure: { readonly error: unknown } | null = null;
	try {
		await removeStaleStagingDirectories(paths.releasesDirectory);
		await mkdir(stagingDirectory, { mode: 0o700 });
		const deployment = await buildStandaloneDeployment({
			environment,
			pnpmCliPath: options.pnpmCliPath,
			sourceDirectory,
			targetDirectory: stagingDirectory,
		});
		const releaseName = createStandaloneReleaseName(
			deployment.version,
			deployment.digest,
		);
		const releaseDirectory = path.join(paths.releasesDirectory, releaseName);
		let reusedRelease = false;
		if ((await pathKind(releaseDirectory)) === "absent") {
			await rename(stagingDirectory, releaseDirectory);
		} else {
			await verifyExistingRelease(releaseDirectory, deployment.digest);
			reusedRelease = true;
			await rm(stagingDirectory, { force: true, recursive: true });
		}
		await activateStandaloneRelease(paths, releaseName);
		operationResult = {
			paths,
			releaseDirectory,
			releaseName,
			reusedRelease,
		};
	} catch (error) {
		operationFailure = { error };
		try {
			await rm(stagingDirectory, { force: true, recursive: true });
		} catch (cleanupError) {
			process.stderr.write(
				`git-commits-push installer could not remove its staging directory: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
			);
		}
	}
	let releaseFailure: { readonly error: unknown } | null = null;
	try {
		releaseInstallLock(paths.installLockPath, lockOwner);
	} catch (error) {
		releaseFailure = { error };
	}
	if (operationFailure !== null) {
		if (releaseFailure !== null) {
			process.stderr.write(
				`git-commits-push installer could not release its lock: ${releaseFailure.error instanceof Error ? releaseFailure.error.message : String(releaseFailure.error)}\n`,
			);
		}
		throw operationFailure.error;
	}
	if (releaseFailure !== null) throw releaseFailure.error;
	if (operationResult === null) {
		throw new Error("Standalone installation completed without a result.");
	}
	return operationResult;
}
