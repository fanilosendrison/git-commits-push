import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isDirectExecution(
	moduleUrl: string,
	entrypointArgument: string | undefined = process.argv[1],
): boolean {
	if (entrypointArgument === undefined) return false;

	try {
		return (
			realpathSync(fileURLToPath(moduleUrl)) ===
			realpathSync(path.resolve(entrypointArgument))
		);
	} catch {
		return false;
	}
}
