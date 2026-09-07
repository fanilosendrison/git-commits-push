import { existsSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Resolve the retired skill-local application state container. */
export function resolveLegacyApplicationStateDirectory(
	homeDirectory = os.homedir(),
) {
	return path.join(
		homeDirectory,
		".agents",
		"skills",
		"git-commits-push",
		".state",
	);
}

/**
 * Fail closed until default state has been explicitly migrated out of the
 * retired skill runtime. ORDER_STATE_DIR is an explicit location override and
 * therefore does not participate in the default-state migration contract.
 */
export function assertLegacyApplicationStateMigrated({
	environment = process.env,
	homeDirectory = os.homedir(),
} = {}) {
	if (environment.ORDER_STATE_DIR !== undefined) return;
	const legacyStateRoot = resolveLegacyApplicationStateDirectory(homeDirectory);
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
		`legacy application state ${stateKind} still exists at ${legacyStateRoot}; run \`pnpm run migrate:state\` from the dedicated git-commits-push repository before launch`,
	);
}
