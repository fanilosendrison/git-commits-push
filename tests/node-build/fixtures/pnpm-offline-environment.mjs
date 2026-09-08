import { spawnSync } from "node:child_process";
import path from "node:path";

function resolvePnpmCacheDirectory(environment) {
	const homeDirectory = environment.HOME;
	if (!homeDirectory || !path.isAbsolute(homeDirectory)) {
		throw new Error("A prepared pnpm cache requires an absolute HOME.");
	}
	if (process.platform === "darwin") {
		return path.join(homeDirectory, "Library", "Caches", "pnpm");
	}
	const configuredCacheHome = environment.XDG_CACHE_HOME;
	const cacheHome =
		configuredCacheHome && path.isAbsolute(configuredCacheHome)
			? configuredCacheHome
			: path.join(homeDirectory, ".cache");
	return path.join(cacheHome, "pnpm");
}

/** Reuse the already-populated workspace store while forbidding test-time downloads. */
export function resolvePnpmOfflineEnvironment(
	pnpmCliPath,
	workingDirectory,
	environment = process.env,
) {
	const networkDisabledEnvironment = {
		...environment,
		COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
		COREPACK_HOME:
			environment.COREPACK_HOME ??
			path.join(environment.HOME ?? "", ".cache", "node", "corepack"),
		COREPACK_ENABLE_NETWORK: "0",
	};
	const result = spawnSync(process.execPath, [pnpmCliPath, "store", "path"], {
		cwd: workingDirectory,
		encoding: "utf8",
		env: networkDisabledEnvironment,
		shell: false,
	});
	if (result.status !== 0 || result.signal !== null) {
		throw new Error(
			`Could not resolve the prepared pnpm store: ${result.stderr || result.stdout}`,
		);
	}
	const versionedStoreDirectory = result.stdout.trim();
	if (!path.isAbsolute(versionedStoreDirectory)) {
		throw new Error("pnpm returned a non-absolute store path.");
	}
	return {
		...networkDisabledEnvironment,
		pnpm_config_cache_dir: resolvePnpmCacheDirectory(environment),
		pnpm_config_offline: "true",
		pnpm_config_store_dir: path.dirname(versionedStoreDirectory),
	};
}
