import { spawn } from "node:child_process";
import { activateGitExecutableForProcess } from "../git/git-executable.ts";

export interface PlatformGitNodeResult {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly gitExecutable: string;
}

/** Give contributor tests the same platform Git selection as the public launcher. */
export async function runNodeWithPlatformGit(
	args: readonly string[],
): Promise<PlatformGitNodeResult> {
	const activation = activateGitExecutableForProcess();
	try {
		const child = spawn(process.execPath, [...args], {
			env: process.env,
			shell: false,
			stdio: "inherit",
		});
		const forward = (signal: NodeJS.Signals): void => {
			if (child.exitCode === null && child.signalCode === null)
				child.kill(signal);
		};
		const interrupt = () => forward("SIGINT");
		const terminate = () => forward("SIGTERM");
		process.on("SIGINT", interrupt);
		process.on("SIGTERM", terminate);
		try {
			return await new Promise<PlatformGitNodeResult>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", (exitCode, signal) =>
					resolve({
						exitCode,
						signal,
						gitExecutable: activation.executable,
					}),
				);
			});
		} finally {
			process.removeListener("SIGINT", interrupt);
			process.removeListener("SIGTERM", terminate);
		}
	} finally {
		activation.restore();
	}
}
