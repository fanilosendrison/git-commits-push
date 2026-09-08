import { existsSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Resolve the retired skill-local application state container. */
export function resolveLegacyApplicationStateDirectory(
	homeDirectory: string = os.homedir(),
): string {
	return path.join(
		homeDirectory,
		".agents",
		"skills",
		"git-commits-push",
		".state",
	);
}

/** Fail closed until default state has left the retired skill directory. */
export function assertLegacyApplicationStateMigrated(
	options: {
		readonly environment?: NodeJS.ProcessEnv;
		readonly homeDirectory?: string;
	} = {},
): void {
	const environment = options.environment ?? process.env;
	if (environment.ORDER_STATE_DIR !== undefined) return;
	const legacyStateRoot = resolveLegacyApplicationStateDirectory(
		options.homeDirectory,
	);
	if (!existsSync(legacyStateRoot)) return;

	let stateKind = "filesystem entry";
	try {
		const stats = lstatSync(legacyStateRoot);
		if (stats.isDirectory() && !stats.isSymbolicLink()) {
			stateKind = "directory";
		}
	} catch {
		stateKind = "unreadable filesystem entry";
	}
	throw new Error(
		`legacy application state ${stateKind} still exists at ${legacyStateRoot}; run the state migration from the dedicated git-commits-push repository before launch`,
	);
}
