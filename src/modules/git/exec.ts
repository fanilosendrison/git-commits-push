import { execSync } from "node:child_process";

export const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

/**
 * Run a git command and return trimmed stdout.
 * Throws on non-zero exit with stderr in the error message.
 */
export function gitExec(args: string, cwd: string): string {
	return execSync(`git ${args}`, {
		cwd,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		env: GIT_ENV,
	}).trim();
}
