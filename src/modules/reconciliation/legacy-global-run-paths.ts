import * as os from "node:os";
import * as path from "node:path";
import type { LegacyGlobalRunCutoverPaths } from "./legacy-global-run-cutover.ts";

export const GCP_TURNLOCK_ORCHESTRATOR_NAME = "git-commits-push-tl";
export const LEGACY_GLOBAL_QUARANTINE_ENV =
	"GCP_LEGACY_GLOBAL_QUARANTINE" as const;
export const TURNLOCK_RUN_ROOT_ENV = "TURNLOCK_RUN_DIR_ROOT" as const;
export const TURNLOCK_MANAGEMENT_DIRECTORY_NAMES = [
	".namespace",
	".retired",
] as const;

function requireAbsolutePath(candidate: string, label: string): string {
	if (!path.isAbsolute(candidate)) {
		throw new Error(`${label} must resolve to an absolute path.`);
	}
	return path.normalize(candidate);
}

/** Resolve the canonical run namespace and its same-parent revocation archive. */
export function resolveLegacyGlobalRunCutoverPaths(
	environment: NodeJS.ProcessEnv,
	homeDirectory: string = os.homedir(),
): LegacyGlobalRunCutoverPaths {
	const configuredRunRoot = environment[TURNLOCK_RUN_ROOT_ENV];
	const turnlockRunRoot =
		configuredRunRoot === undefined || configuredRunRoot === ""
			? path.join(homeDirectory, ".turnlock", "runs")
			: requireAbsolutePath(configuredRunRoot, TURNLOCK_RUN_ROOT_ENV);
	const configuredQuarantine = environment[LEGACY_GLOBAL_QUARANTINE_ENV];
	const quarantineDirectory =
		configuredQuarantine === undefined || configuredQuarantine === ""
			? path.join(
					path.dirname(turnlockRunRoot),
					"git-commits-push-revoked-runs",
					GCP_TURNLOCK_ORCHESTRATOR_NAME,
				)
			: requireAbsolutePath(configuredQuarantine, LEGACY_GLOBAL_QUARANTINE_ENV);
	return {
		quarantineDirectory,
		runsDirectory: path.join(turnlockRunRoot, GCP_TURNLOCK_ORCHESTRATOR_NAME),
	};
}
