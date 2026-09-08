import os from "node:os";
import path from "node:path";

const APPLICATION_DIRECTORY_NAME = "git-commits-push";
const EXECUTABLE_NAME = "git-commits-push";

export interface StandaloneInstallPaths {
	readonly applicationDirectory: string;
	readonly releasesDirectory: string;
	readonly currentReleaseLink: string;
	readonly publicExecutablePath: string;
	readonly installLockPath: string;
}

export interface ResolveStandaloneInstallPathsOptions {
	readonly environment?: NodeJS.ProcessEnv;
	readonly homeDirectory?: string;
}

export function requireAbsolutePath(candidate: string, label: string): string {
	if (!path.isAbsolute(candidate)) {
		throw new Error(`${label} must resolve to an absolute path.`);
	}
	return path.normalize(candidate);
}

function resolveDataHome(
	environment: NodeJS.ProcessEnv,
	homeDirectory: string,
): string {
	const configured = environment.XDG_DATA_HOME;
	if (configured !== undefined && configured.length > 0) {
		const expanded = configured.startsWith("~/")
			? path.join(homeDirectory, configured.slice(2))
			: configured;
		return requireAbsolutePath(expanded, "XDG_DATA_HOME");
	}
	return path.join(homeDirectory, ".local", "share");
}

/** Resolve the XDG release store and stable user-local executable paths. */
export function resolveStandaloneInstallPaths(
	options: ResolveStandaloneInstallPathsOptions = {},
): StandaloneInstallPaths {
	const environment = options.environment ?? process.env;
	const homeDirectory = requireAbsolutePath(
		options.homeDirectory ?? os.homedir(),
		"Home directory",
	);
	const applicationDirectory = path.join(
		resolveDataHome(environment, homeDirectory),
		APPLICATION_DIRECTORY_NAME,
	);
	const binDirectory = path.join(homeDirectory, ".local", "bin");
	return {
		applicationDirectory,
		currentReleaseLink: path.join(applicationDirectory, "current"),
		installLockPath: path.join(
			binDirectory,
			`.${EXECUTABLE_NAME}-install.lock`,
		),
		publicExecutablePath: path.join(binDirectory, EXECUTABLE_NAME),
		releasesDirectory: path.join(applicationDirectory, "releases"),
	};
}
