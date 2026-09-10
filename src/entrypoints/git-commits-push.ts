import { realpathSync } from "node:fs";
import path from "node:path";
import { activateGitExecutableForProcess } from "../modules/git/git-executable.ts";
import { runPublicLauncher } from "../modules/reconciliation/public-launcher.ts";
import { isDirectExecution } from "../utils/direct-execution.ts";

/** Run the installed, precompiled git-commits-push application. */
export async function runStandaloneCli(
	passthroughArguments: readonly string[] = process.argv.slice(2),
): Promise<number> {
	const gitActivation = activateGitExecutableForProcess();
	try {
		const compiledApplicationDirectory = realpathSync(
			path.resolve(import.meta.dirname, "../.."),
		);
		return await runPublicLauncher({
			compiledApplicationDirectory,
			passthroughArguments,
		});
	} finally {
		gitActivation.restore();
	}
}

if (isDirectExecution(import.meta.url)) {
	process.exitCode = await runStandaloneCli();
}
