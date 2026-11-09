import { execFileSync, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createTrustToken,
	TRUSTED_MARKER_ENV,
	TRUSTED_MARKER_VALUE,
	TRUSTED_TOKEN_ENV,
} from "@git-commits-push/trust";
import type { FrozenCommitIdentity } from "./prepared-merge-identity.ts";

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

export type GitExecutionPolicy = "inherit" | "prepared-merge";
/** Prepared effects cannot execute ambient hooks or commit/push signing programs. */
export const PREPARED_MERGE_PROCESS_CONFIGURATION: readonly GitProcessConfigEntry[] =
	Object.freeze([
		{ key: "core.hooksPath", value: "/dev/null" },
		{ key: "commit.gpgSign", value: "false" },
		{ key: "push.gpgSign", value: "false" },
		// Git 2.17 treats the string "false" as a hook executable; empty disables it.
		{ key: "core.fsmonitor", value: "" },
		{ key: "core.untrackedCache", value: "false" },
	]);

/** Derive child-process configuration only from explicit caller-selected operation policy. */
export function gitExecutionProcessConfiguration(
	policy: GitExecutionPolicy,
): readonly GitProcessConfigEntry[] {
	return policy === "prepared-merge"
		? PREPARED_MERGE_PROCESS_CONFIGURATION
		: [];
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
		LC_ALL: "C",
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

function executeGitArgs(
	args: readonly string[],
	cwd: string,
	processConfig: readonly GitProcessConfigEntry[],
	actualGraph = false,
	indexPath?: string,
	input?: string,
	identities?: {
		readonly author: FrozenCommitIdentity;
		readonly committer: FrozenCommitIdentity;
	},
): string {
	return execFileSync("git", [...args], {
		cwd,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		...(input === undefined ? {} : { input }),
		env: {
			...buildGitEnv(processConfig),
			...(actualGraph ? { GIT_GRAFT_FILE: "" } : {}),
			...(indexPath ? { GIT_INDEX_FILE: indexPath } : {}),
			...(identities
				? {
						GIT_AUTHOR_NAME: identities.author.name,
						GIT_AUTHOR_EMAIL: identities.author.email,
						GIT_AUTHOR_DATE: `@${identities.author.date}`,
						GIT_COMMITTER_NAME: identities.committer.name,
						GIT_COMMITTER_EMAIL: identities.committer.email,
						GIT_COMMITTER_DATE: `@${identities.committer.date}`,
					}
				: {}),
		},
		maxBuffer: 50 * 1024 * 1024,
	});
}

/** Supply literal stdin through the same governed Git subprocess boundary. */
export function gitExecInputArgs(
	args: readonly string[],
	cwd: string,
	input: string,
	processConfig: readonly GitProcessConfigEntry[] = [],
): string {
	return executeGitArgs(args, cwd, processConfig, false, undefined, input);
}

/** Create one deterministic object from explicit parents/tree, never optional merge metadata. */
export function gitCreatePreparedCommit(
	repository: string,
	tree: string,
	parents: readonly [string, string],
	messageFile: string,
	identities: {
		readonly author: FrozenCommitIdentity;
		readonly committer: FrozenCommitIdentity;
	},
): string {
	return executeGitArgs(
		[
			"--no-replace-objects",
			"commit-tree",
			tree,
			"-p",
			parents[0],
			"-p",
			parents[1],
			"--no-gpg-sign",
			"-F",
			messageFile,
		],
		repository,
		[
			...PREPARED_MERGE_PROCESS_CONFIGURATION,
			{ key: "i18n.commitEncoding", value: "UTF-8" },
		],
		false,
		undefined,
		undefined,
		identities,
	).trim();
}

/** Run Git without a shell and return stdout with surrounding whitespace removed. */
export function gitExecArgs(
	args: readonly string[],
	cwd: string,
	processConfig: readonly GitProcessConfigEntry[] = [],
): string {
	return executeGitArgs(args, cwd, processConfig).trim();
}

/** Read actual parentage without repository mutation (Git >= 2.17).
 * Empty shallow/graft overrides suppress both default and ambient graph masks;
 * callers still own local-object/no-fetch policy for the selected Git command.
 */
export function gitExecActualGraphArgs(
	args: readonly string[],
	cwd: string,
	executionPolicy: GitExecutionPolicy = "inherit",
): string {
	return executeGitArgs(
		["--no-replace-objects", "--shallow-file", "", ...args],
		cwd,
		gitExecutionProcessConfiguration(executionPolicy),
		true,
	).trim();
}

/** Inspect an immutable source through a private index, never the caller's index. */
export function gitExecIndexArgs(
	args: readonly string[],
	cwd: string,
	indexPath: string,
	input?: string,
	executionPolicy: GitExecutionPolicy = "inherit",
): string {
	return executeGitArgs(
		["--no-replace-objects", "--no-optional-locks", ...args],
		cwd,
		gitExecutionProcessConfiguration(executionPolicy),
		false,
		indexPath,
		input,
	);
}

/** Run Git without a shell while preserving machine-readable stdout exactly. */
export function gitExecArgsRaw(
	args: readonly string[],
	cwd: string,
	processConfig: readonly GitProcessConfigEntry[] = [],
): string {
	return executeGitArgs(args, cwd, processConfig);
}
