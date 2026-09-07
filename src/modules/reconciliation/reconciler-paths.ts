import * as os from "node:os";
import * as path from "node:path";

export const RECONCILER_DB_FILE_NAME = "reconciler.sqlite";
export const APPLICATION_STATE_DIRECTORY_NAME = "git-commits-push";
export const RECONCILER_STATE_DIRECTORY_NAME = "orders";
export const NODE_CUTOVER_CLOSURE_LEDGER_FILE_NAME =
	"node-cutover-closures.json";

function expandHome(candidate: string, homeDirectory: string): string {
	if (candidate === "~") return homeDirectory;
	if (candidate.startsWith("~/")) {
		return path.join(homeDirectory, candidate.slice(2));
	}
	return candidate;
}

function requireAbsolutePath(candidate: string, variableName: string): string {
	if (!path.isAbsolute(candidate)) {
		throw new Error(`${variableName} must resolve to an absolute path.`);
	}
	return path.normalize(candidate);
}

/** Resolve the location-independent application state container. */
export function resolveApplicationStateDirectory(
	environment: NodeJS.ProcessEnv,
	homeDirectory: string = os.homedir(),
): string {
	const configuredStateHome = environment.XDG_STATE_HOME;
	if (configuredStateHome !== undefined && configuredStateHome.length > 0) {
		const stateHome = requireAbsolutePath(
			expandHome(configuredStateHome, homeDirectory),
			"XDG_STATE_HOME",
		);
		return path.join(stateHome, APPLICATION_STATE_DIRECTORY_NAME);
	}
	return path.join(
		homeDirectory,
		".local",
		"state",
		APPLICATION_STATE_DIRECTORY_NAME,
	);
}

/** Resolve the compatibility override or the location-independent default. */
export function resolveReconcilerStateDirectory(
	environment: NodeJS.ProcessEnv,
	homeDirectory: string = os.homedir(),
): string {
	if (environment.ORDER_STATE_DIR !== undefined) {
		return requireAbsolutePath(
			expandHome(environment.ORDER_STATE_DIR, homeDirectory),
			"ORDER_STATE_DIR",
		);
	}
	return path.join(
		resolveApplicationStateDirectory(environment, homeDirectory),
		RECONCILER_STATE_DIRECTORY_NAME,
	);
}

export function resolveNodeCutoverClosureLedgerPath(
	environment: NodeJS.ProcessEnv,
	homeDirectory: string = os.homedir(),
): string {
	if (environment.GCP_NODE_CUTOVER_CLOSURE_LEDGER !== undefined) {
		return requireAbsolutePath(
			expandHome(environment.GCP_NODE_CUTOVER_CLOSURE_LEDGER, homeDirectory),
			"GCP_NODE_CUTOVER_CLOSURE_LEDGER",
		);
	}
	return path.join(
		resolveApplicationStateDirectory(environment, homeDirectory),
		NODE_CUTOVER_CLOSURE_LEDGER_FILE_NAME,
	);
}

export function resolveReconcilerDbPath(stateDirectory: string): string {
	return path.join(stateDirectory, RECONCILER_DB_FILE_NAME);
}
