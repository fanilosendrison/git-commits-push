import { realpathSync } from "node:fs";
import path from "node:path";
import { runPublicLauncher } from "../modules/reconciliation/public-launcher.ts";
import { isDirectExecution } from "../utils/direct-execution.ts";

/** Run the installed, precompiled git-commits-push application. */
export async function runStandaloneCli(
	passthroughArguments: readonly string[] = process.argv.slice(2),
): Promise<number> {
	const compiledApplicationDirectory = realpathSync(
		path.resolve(import.meta.dirname, "../.."),
	);
	return runPublicLauncher({
		compiledApplicationDirectory,
		passthroughArguments,
	});
}

if (isDirectExecution(import.meta.url)) {
	process.exitCode = await runStandaloneCli();
}
