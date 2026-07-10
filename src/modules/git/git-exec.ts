import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createTrustToken,
	TRUSTED_MARKER_ENV,
	TRUSTED_MARKER_VALUE,
	TRUSTED_TOKEN_ENV,
} from "../../../../../agent-enforcers/git-commits-push-enforcer/src/core/trust-store";

function testOnlyGravityTelemetryEnv(): Record<string, string> {
	if (
		process.env.NODE_ENV !== "test" ||
		process.env.GIT_COMMITS_PUSH_ENFORCER_STATS_DIR
	) {
		return {};
	}

	return {
		GIT_COMMITS_PUSH_ENFORCER_STATS_DIR:
			process.env.PI_SKILL_STATS_DIR ??
			process.env.SECRET_SCANNER_STATS_DIR ??
			join(tmpdir(), "git-commits-push-test-stats"),
	};
}

function buildGitEnv(): Record<string, string> {
	return {
		...process.env,
		...testOnlyGravityTelemetryEnv(),
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
