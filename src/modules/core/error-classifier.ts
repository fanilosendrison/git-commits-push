import type { FeedbackError } from "../../types.ts";
import type { CommitPlanErrorKind } from "./errors.ts";
import {
	CommitPlanError,
	DiffHashMismatchError,
	GitExecError,
	PartialCommitError,
	PushError,
} from "./errors.ts";

export function classifyError(
	err: unknown,
	committedShasExist: boolean,
): { kind: "retry" | "fail"; error: FeedbackError } | { kind: "success" } {
	if (err instanceof CommitPlanError) {
		if (err.kind === "empty-plans" && committedShasExist) {
			return { kind: "success" };
		}
		return {
			kind: "retry",
			error: {
				kind: "structural",
				message: err.message,
				resolution_hint: getResolutionHint(err.kind),
				files: err.files,
			},
		};
	}

	if (err instanceof DiffHashMismatchError) {
		return {
			kind: "retry",
			error: {
				kind: "race",
				message: err.message,
				resolution_hint:
					"The diff changed during inference. Regenerate based on the current diff.",
			},
		};
	}

	if (err instanceof PartialCommitError) {
		return {
			kind: "retry",
			error: {
				kind: "git",
				message: err.message,
				resolution_hint:
					"Re-decide the plan based on the pending files (provided below).",
			},
		};
	}

	if (err instanceof GitExecError) {
		return {
			kind: "fail",
			error: { kind: "git", message: err.message },
		};
	}

	if (err instanceof PushError) {
		if (err.transient) {
			return {
				kind: "retry",
				error: { kind: "network", message: err.message },
			};
		}
		return {
			kind: "fail",
			error: { kind: "network", message: err.message },
		};
	}

	return {
		kind: "fail",
		error: {
			kind: "git",
			message: err instanceof Error ? err.message : String(err),
		},
	};
}

export function getResolutionHint(kind: CommitPlanErrorKind): string {
	switch (kind) {
		case "duplicate-file":
			return "Either split the duplicated file beforehand, or merge all changes touching it into a single Fat Commit plan (use the most impactful type: feat > fix > refactor > chore).";
		case "missing-file":
			return "The file has no changes to commit (already committed or empty). Remove it from the plan.";
		case "nonexistent-file":
			return "The file path does not exist on disk in the working directory. Use only paths that appear in the staged diff (the `diff` parameter). Remove the path from the plan or fix the path spelling.";
		case "empty-plans":
			return "If pending_files is empty AND committed_shas covers everything, return an empty array []. Otherwise, generate plans that cover the pending_files exactly (plus any files you regroup via Fat Commit).";
		default: {
			const _exhaustive: never = kind;
			return _exhaustive;
		}
	}
}

const LLM_BRIDGE_ERROR_PREFIX = "LLM Fatal Error:";
const LLM_FATAL_SIGNATURES: readonly string[] = [LLM_BRIDGE_ERROR_PREFIX];

export function classifyLLMFailure(
	error: string,
): FeedbackError["kind"] | null {
	if (error.includes("validation rejected")) {
		return "validation";
	}

	for (const sig of LLM_FATAL_SIGNATURES) {
		if (error.includes(sig)) return null;
	}

	return null;
}
