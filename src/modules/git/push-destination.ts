import { gitExecArgs } from "./git-exec.ts";

export interface LocalTrackingRefCandidate {
	readonly ref: string;
	readonly expectedSha: string | null;
}

export interface TrackedPushDestination {
	readonly upstreamRef: string;
	readonly remote: string;
	readonly destinationRef: string;
	readonly localTrackingRef: LocalTrackingRefCandidate | null;
}

export interface CurrentPushDestination {
	readonly sourceBranch: string;
	readonly remote: string;
	readonly destinationRef: string;
	readonly establishUpstream: boolean;
	readonly localTrackingRef: LocalTrackingRefCandidate | null;
}

type SupportedPushDefault = "current" | "simple" | "upstream";

function readOptionalGit(
	args: readonly string[],
	repository: string,
): string | null {
	try {
		return gitExecArgs(args, repository) || null;
	} catch {
		return null;
	}
}

function splitNonemptyLines(value: string): string[] {
	return value
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function readConfiguredRemotes(repository: string): string[] {
	return splitNonemptyLines(readOptionalGit(["remote"], repository) ?? "");
}

function readConfiguredPushRemote(
	repository: string,
	sourceBranch: string,
): string | null {
	return (
		readOptionalGit(
			["config", "--get", `branch.${sourceBranch}.pushRemote`],
			repository,
		) ?? readOptionalGit(["config", "--get", "remote.pushDefault"], repository)
	);
}

function readBranchRemote(
	repository: string,
	sourceBranch: string,
): string | null {
	return readOptionalGit(
		["config", "--get", `branch.${sourceBranch}.remote`],
		repository,
	);
}

function resolveLocalTrackingRef(
	repository: string,
	sourceBranch: string,
	upstreamRemote: string,
	pushRemote: string,
	upstreamDestinationRef: string,
	pushDestinationRef: string,
): LocalTrackingRefCandidate | null {
	if (
		pushRemote !== upstreamRemote ||
		pushDestinationRef !== upstreamDestinationRef
	) {
		return null;
	}
	const ref = readOptionalGit(
		[
			"for-each-ref",
			"--format=%(upstream)",
			"--",
			`refs/heads/${sourceBranch}`,
		],
		repository,
	);
	if (!ref?.startsWith("refs/remotes/")) return null;
	const expectedSha = readOptionalGit(
		["rev-parse", "--verify", ref],
		repository,
	);
	return { ref, expectedSha };
}

function assertConfiguredRemote(
	remote: string | null,
	configuredRemotes: readonly string[],
	sourceBranch: string,
): string {
	if (!remote || remote === "." || !configuredRemotes.includes(remote)) {
		throw new Error(
			`Branch ${sourceBranch} has no supported remote push destination.`,
		);
	}
	return remote;
}

function readPushDefault(repository: string): SupportedPushDefault {
	const configured =
		readOptionalGit(["config", "--get", "push.default"], repository) ??
		"simple";
	if (
		configured === "current" ||
		configured === "simple" ||
		configured === "upstream"
	) {
		return configured;
	}
	throw new Error(
		`push.default=${configured} is incompatible with exact single-branch publication.`,
	);
}

function resolveTrackedDestinationRef(
	repository: string,
	sourceBranch: string,
	upstreamRemote: string,
	pushRemote: string,
	upstreamDestinationRef: string,
): string {
	const pushDefault = readPushDefault(repository);
	const currentBranchDestinationRef = `refs/heads/${sourceBranch}`;
	if (pushDefault === "current") return currentBranchDestinationRef;

	if (pushDefault === "upstream") {
		if (pushRemote !== upstreamRemote) {
			throw new Error(
				"push.default=upstream cannot publish to a remote different from the upstream remote.",
			);
		}
		return upstreamDestinationRef;
	}

	if (pushRemote !== upstreamRemote) {
		return currentBranchDestinationRef;
	}
	if (upstreamDestinationRef !== currentBranchDestinationRef) {
		throw new Error(
			`push.default=simple requires branch ${sourceBranch} to have an upstream branch with the same name.`,
		);
	}
	return upstreamDestinationRef;
}

/** Resolve a tracked branch using Git's normal push-remote precedence. */
export function resolveTrackedPushDestination(
	repository: string,
	sourceBranch: string,
): TrackedPushDestination | null {
	const upstreamRef = readOptionalGit(
		["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
		repository,
	);
	if (!upstreamRef) return null;
	const upstreamDestinationRef = readOptionalGit(
		["config", "--get", `branch.${sourceBranch}.merge`],
		repository,
	);
	if (!upstreamDestinationRef?.startsWith("refs/heads/")) {
		throw new Error(
			`Tracked branch ${sourceBranch} has no supported destination ref.`,
		);
	}
	const configuredRemotes = readConfiguredRemotes(repository);
	const upstreamRemote = assertConfiguredRemote(
		readBranchRemote(repository, sourceBranch),
		configuredRemotes,
		sourceBranch,
	);
	const remote = assertConfiguredRemote(
		readConfiguredPushRemote(repository, sourceBranch) ?? upstreamRemote,
		configuredRemotes,
		sourceBranch,
	);
	const destinationRef = resolveTrackedDestinationRef(
		repository,
		sourceBranch,
		upstreamRemote,
		remote,
		upstreamDestinationRef,
	);
	return {
		upstreamRef,
		remote,
		destinationRef,
		localTrackingRef: resolveLocalTrackingRef(
			repository,
			sourceBranch,
			upstreamRemote,
			remote,
			upstreamDestinationRef,
			destinationRef,
		),
	};
}

/** Resolve the current branch for exact publication, including first push. */
export function resolveCurrentPushDestination(
	repository: string,
): CurrentPushDestination | null {
	const configuredRemotes = readConfiguredRemotes(repository);
	if (configuredRemotes.length === 0) return null;
	const sourceBranch = readOptionalGit(
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		repository,
	);
	if (!sourceBranch) {
		throw new Error("Detached HEAD has no automatic push destination.");
	}
	const tracked = resolveTrackedPushDestination(repository, sourceBranch);
	if (tracked) {
		return {
			sourceBranch,
			remote: tracked.remote,
			destinationRef: tracked.destinationRef,
			establishUpstream: false,
			localTrackingRef: tracked.localTrackingRef,
		};
	}
	const preferredRemote =
		readConfiguredPushRemote(repository, sourceBranch) ??
		readBranchRemote(repository, sourceBranch);
	const remote = preferredRemote
		? assertConfiguredRemote(preferredRemote, configuredRemotes, sourceBranch)
		: configuredRemotes[0];
	if (!remote) return null;
	return {
		sourceBranch,
		remote,
		destinationRef: `refs/heads/${sourceBranch}`,
		establishUpstream: true,
		localTrackingRef: null,
	};
}
