import * as os from "node:os";
import * as path from "node:path";

export const RECONCILER_DB_FILE_NAME = "reconciler.sqlite";

function expandHome(candidate: string): string {
	if (candidate === "~") return os.homedir();
	if (candidate.startsWith("~/")) {
		return path.join(os.homedir(), candidate.slice(2));
	}
	return candidate;
}

/** Resolve the compatibility state-directory override or package default. */
export function resolveReconcilerStateDirectory(
	environment: NodeJS.ProcessEnv,
	skillDirectory: string,
): string {
	if (environment.ORDER_STATE_DIR) {
		return expandHome(environment.ORDER_STATE_DIR);
	}
	return path.join(skillDirectory, ".state", "orders");
}

export function resolveReconcilerDbPath(stateDirectory: string): string {
	return path.join(stateDirectory, RECONCILER_DB_FILE_NAME);
}
