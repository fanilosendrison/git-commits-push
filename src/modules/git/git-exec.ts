import { execSync } from "node:child_process";
import { createTrustToken, TRUSTED_MARKER_ENV, TRUSTED_MARKER_VALUE, TRUSTED_TOKEN_ENV } from "../../../../../agent-enforcers/git-commits-push-enforcer/src/core/trust-store";

function buildGitEnv(): Record<string, string> {
	return {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		[TRUSTED_MARKER_ENV]: TRUSTED_MARKER_VALUE,
		[TRUSTED_TOKEN_ENV]: createTrustToken(),
	} as Record<string, string>;
}

/**
 * Run a git command and return trimmed stdout.
 * Throws on non-zero exit with stderr in the error message.
 */
export function gitExec(args: string, cwd: string): string {
	return execSync(`git ${args}`, {
		cwd,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		env: buildGitEnv(),
	}).trim();
}
