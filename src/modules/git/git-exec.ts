import { execFileSync, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createTrustToken,
	TRUSTED_MARKER_ENV,
	TRUSTED_MARKER_VALUE,
	TRUSTED_TOKEN_ENV,
} from "../../../../../agent-enforcers/git-commits-push-enforcer/src/core/trust-store.ts";

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

export interface GitProcessConfigEntry {
	readonly key: string;
	readonly value: string;
}

function quoteGitConfigParameter(entry: GitProcessConfigEntry): string {
	const parameter = `${entry.key}=${entry.value}`;
	return `'${parameter.replaceAll("'", `'\\''`)}'`;
}

function appendProcessConfig(
	environment: NodeJS.ProcessEnv,
	entries: readonly GitProcessConfigEntry[],
): NodeJS.ProcessEnv {
	if (entries.length === 0) return environment;
	const ambientParameters = environment.GIT_CONFIG_PARAMETERS?.trim();
	const appendedParameters = entries.map(quoteGitConfigParameter).join(" ");
	return {
		...environment,
		GIT_CONFIG_PARAMETERS: ambientParameters
			? `${ambientParameters} ${appendedParameters}`
			: appendedParameters,
	};
}

function buildGitEnv(
	processConfig: readonly GitProcessConfigEntry[] = [],
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		...testOnlyGravityTelemetryEnv(),
		GIT_TERMINAL_PROMPT: "0",
		[TRUSTED_MARKER_ENV]: TRUSTED_MARKER_VALUE,
		[TRUSTED_TOKEN_ENV]: createTrustToken(),
	};
	return appendProcessConfig(environment, processConfig);
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
		maxBuffer: 50 * 1024 * 1024, // 50 MB — avoids ENOBUFS on verbose hooks
	}).trim();
}

/** Run Git without a shell when arguments contain discovered refs or remotes. */
export function gitExecArgs(
	args: readonly string[],
	cwd: string,
	processConfig: readonly GitProcessConfigEntry[] = [],
): string {
	return execFileSync("git", [...args], {
		cwd,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		env: buildGitEnv(processConfig),
		maxBuffer: 50 * 1024 * 1024,
	}).trim();
}
