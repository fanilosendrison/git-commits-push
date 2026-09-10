import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { release, tmpdir } from "node:os";
import path from "node:path";

const MAXIMUM_LEGACY_DARWIN_KERNEL_MAJOR = 17;
const MINIMUM_GIT_VERSION = Object.freeze({ major: 2, minor: 17, patch: 0 });
const GIT_VERSION_PATTERN = /^git version (\d+)\.(\d+)(?:\.(\d+))?/u;

export interface GitExecutableResolutionInput {
	readonly platform: string;
	readonly kernelRelease: string;
	readonly resolveDeveloperGit: () => string;
}

export interface GitExecutableActivation {
	readonly executable: string;
	restore(): void;
}

function defaultDeveloperGitResolver(): string {
	return execFileSync("xcrun", ["--find", "git"], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function quoteShellArgument(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isLegacyDarwin(platform: string, kernelRelease: string): boolean {
	if (platform !== "darwin") return false;
	const kernelMajor = Number.parseInt(kernelRelease.split(".")[0] ?? "", 10);
	return (
		Number.isInteger(kernelMajor) &&
		kernelMajor <= MAXIMUM_LEGACY_DARWIN_KERNEL_MAJOR
	);
}

function validateGitExecutable(candidate: string): string {
	if (!path.isAbsolute(candidate)) {
		throw new Error("xcrun returned a non-absolute Git executable path.");
	}
	let executable: string;
	try {
		executable = realpathSync(candidate);
		const stats = statSync(executable);
		if (!stats.isFile() || (stats.mode & 0o111) === 0) {
			throw new Error("resolved path is not an executable file");
		}
	} catch (error) {
		throw new Error(
			`Apple toolchain Git is unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	let versionOutput: string;
	try {
		versionOutput = execFileSync(executable, ["--version"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		throw new Error(
			`Apple toolchain Git version check failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const match = GIT_VERSION_PATTERN.exec(versionOutput);
	if (!match) {
		throw new Error("Apple toolchain Git returned an unrecognized version.");
	}
	const version = {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3] ?? 0),
	};
	const supported =
		version.major > MINIMUM_GIT_VERSION.major ||
		(version.major === MINIMUM_GIT_VERSION.major &&
			(version.minor > MINIMUM_GIT_VERSION.minor ||
				(version.minor === MINIMUM_GIT_VERSION.minor &&
					version.patch >= MINIMUM_GIT_VERSION.patch)));
	if (!supported) {
		throw new Error(
			`Legacy Darwin requires Git >= 2.17.0; found ${version.major}.${version.minor}.${version.patch}.`,
		);
	}
	return executable;
}

/** Resolve a TLS-compatible Git on legacy Darwin and preserve PATH Git elsewhere. */
export function resolveGitExecutable(
	input: GitExecutableResolutionInput = {
		platform: process.platform,
		kernelRelease: release(),
		resolveDeveloperGit: defaultDeveloperGitResolver,
	},
): string {
	if (!isLegacyDarwin(input.platform, input.kernelRelease)) return "git";
	let candidate: string;
	try {
		candidate = input.resolveDeveloperGit();
	} catch (error) {
		throw new Error(
			`Cannot resolve Apple toolchain Git on legacy Darwin: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return validateGitExecutable(candidate);
}

/** Activate the selected Git for this process and every descendant command. */
export function activateGitExecutableForProcess(
	input?: GitExecutableResolutionInput,
): GitExecutableActivation {
	const executable = resolveGitExecutable(input);
	if (!path.isAbsolute(executable)) {
		return { executable, restore() {} };
	}

	const originalPath = process.env.PATH;
	const commandDirectory = mkdtempSync(
		path.join(tmpdir(), "git-commits-push-git-"),
	);
	try {
		const wrapper = path.join(commandDirectory, "git");
		writeFileSync(
			wrapper,
			`#!/bin/sh\nexec ${quoteShellArgument(executable)} "$@"\n`,
			{ mode: 0o700 },
		);
		chmodSync(wrapper, 0o700);
	} catch (error) {
		rmSync(commandDirectory, { force: true, recursive: true });
		throw error;
	}
	process.env.PATH = originalPath
		? `${commandDirectory}${path.delimiter}${originalPath}`
		: commandDirectory;
	let active = true;
	return {
		executable,
		restore(): void {
			if (!active) return;
			active = false;
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			try {
				rmSync(commandDirectory, { force: true, recursive: true });
			} catch {
				// Cleanup cannot change an already determined Git operation result.
			}
		},
	};
}
