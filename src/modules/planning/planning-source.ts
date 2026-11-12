import { createHash } from "node:crypto";
import type { RepoState, Settings } from "../../types.ts";
import { CREATION_DIFF_ARGUMENTS } from "../git/creation-diff.ts";
import { gitExecBytesArgs } from "../git/git-exec.ts";
import {
	assertValidatedSource,
	readEmptyTree,
} from "../git/validated-source.ts";
import {
	readValidationInputDiff,
	readValidationInputDiffBytes,
} from "../git/validation-source-input.ts";
import { assertIndependentPlanningPaths } from "./exact-partitions.ts";
import type { PlanningPathInput, PlanningSource } from "./planning-types.ts";

export function planningSourceFor(
	repo: RepoState | undefined,
	settings: Settings,
): PlanningSource | undefined {
	if (!repo?.validatedSource?.fullDiffHash) return undefined;
	return {
		witness: repo.validatedSource,
		committedShas: repo.committedShas,
		publisherIndexTreeSha: repo.publisherIndexTreeSha,
		creation:
			!!repo.explicitPushTargetSnapshot &&
			"kind" in repo.explicitPushTargetSnapshot,
		maxDiffChars: settings.maxDiffChars ?? 3_000_000,
	};
}

/** Re-read pinned objects and literal path patches, never patch-header splitting. */
export function readPlanningPathInputs(
	repository: string,
	source: PlanningSource,
	currentDiffHash: string,
): PlanningPathInput[] {
	const { witness, remainingPaths, head } = assertValidatedSource(
		repository,
		source.witness,
		source.committedShas,
		source.publisherIndexTreeSha,
	);
	const digest = (s: string | Uint8Array) =>
		createHash("sha256").update(s).digest("hex");
	const original = readValidationInputDiffBytes(repository, witness, true);
	if (!witness.fullDiffHash || digest(original) !== witness.fullDiffHash)
		throw new Error("Full validated planning diff binding changed");
	const remaining = readValidationInputDiff(
		repository,
		{ baseHeadSha: head, expectedTreeSha: witness.expectedTreeSha },
		source.creation,
	);
	if (digest(remaining) !== currentDiffHash || !remainingPaths.length)
		throw new Error("No matching remaining validated planning work");
	// Prove leaf independence before using literal pathspecs, which recurse.
	assertIndependentPlanningPaths(remainingPaths);
	return remainingPaths.map((path) => {
		if (path.includes("\uFFFD"))
			throw new Error("COUNTING_UNSUPPORTED: ambiguous Git pathname encoding");
		const bytes = gitExecBytesArgs(
			[
				"--no-replace-objects",
				"--literal-pathspecs",
				"diff",
				"--patch",
				"--binary",
				...CREATION_DIFF_ARGUMENTS.filter((arg) => arg !== "--text"),
				head ?? readEmptyTree(repository),
				witness.expectedTreeSha,
				"--",
				path,
			],
			repository,
		);
		let patch: string;
		try {
			patch = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				bytes,
			);
		} catch {
			throw new Error(
				"COUNTING_UNSUPPORTED: insufficient faithful Git representation",
			);
		}
		if (!patch) throw new Error("Insufficient Git path representation");
		return { path, patch };
	});
}
