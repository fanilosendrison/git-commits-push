/**
 * src/modules/error-classifier.ts — Pure classification helpers (Phase 4)
 *
 * Contains classifyError, getResolutionHint, and classifyLLMFailure.
 * All three are pure functions with no I/O side effects.
 *
 * Plan ref: Phase 4 — Add helpers at top of file
 *   §7.4 — Error classifier tests
 *   §7.4c — LLM-side error classification tests
 */

import type { FeedbackError } from "../types.ts";
import type { CommitPlanErrorKind } from "./errors.ts";
import {
	CommitPlanError,
	DiffHashMismatchError,
	GitExecError,
	PartialCommitError,
	PushError,
} from "./errors.ts";

// ── classifyError ────────────────────────────────────────────────────────────

/**
 * Classify a thrown error (from the publisher) into a retry decision.
 *
 * Returns a discriminated union:
 *   - { kind: "retry", error }  → caller checks attempts and either retries or fails
 *   - { kind: "fail",  error }  → caller fails the repo closed
 *   - { kind: "success" }       → caller treats as success (empty-plans with commits)
 *
 * Plan ref: R16 + R43 discriminated union shape
 */
export function classifyError(
	err: unknown,
	committedShasExist: boolean,
): { kind: "retry" | "fail"; error: FeedbackError } | { kind: "success" } {
	if (err instanceof CommitPlanError) {
		// R57: empty-plans is success ONLY if commits already landed.
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

	// Unknown error — fail-closed (R7 default)
	return {
		kind: "fail",
		error: {
			kind: "git",
			message: err instanceof Error ? err.message : String(err),
		},
	};
}

// ── getResolutionHint ────────────────────────────────────────────────────────

/**
 * Returns a human-readable resolution hint for a given CommitPlanErrorKind.
 * Used by classifyError to populate FeedbackError.resolution_hint.
 *
 * The default case uses an exhaustiveness check — if a new kind is added to
 * CommitPlanErrorKind but not handled here, TypeScript will error at compile time.
 */
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
			// Exhaustiveness check — TS strict mode errors here if the union grows
			const _exhaustive: never = kind;
			return _exhaustive;
		}
	}
}

// ── classifyLLMFailure ───────────────────────────────────────────────────────

/**
 * Classify an LLM-side failure (result.success === false) by inspecting the
 * error string from the bridge.
 *
 * Returns:
 *   - "validation" for bridge-side validation errors (documented extension point)
 *   - null for all known bridge fatal errors AND unknown errors (fail-closed)
 *
 * Plan ref: R7 + R27 — signature list scoped to known LLM bridge error strings
 * Round 9: LLM_BRIDGE_ERROR_PREFIX matches real bridge output "LLM Fatal Error:"
 */
const LLM_BRIDGE_ERROR_PREFIX = "LLM Fatal Error:";
const LLM_FATAL_SIGNATURES: readonly string[] = [
	// The bridge currently emits a single generic format:
	//   "LLM Fatal Error: <errMsg>"
	// More-specific signatures added BEFORE the prefix will match first.
	LLM_BRIDGE_ERROR_PREFIX,
];

export function classifyLLMFailure(
	error: string,
): FeedbackError["kind"] | null {
	// Documented extension point: if the bridge evolves to emit post-generation
	// validation errors, route them to the validation budget.
	if (error.includes("validation rejected")) {
		return "validation";
	}

	// Known bridge fatal errors → fail-closed (no retry)
	for (const sig of LLM_FATAL_SIGNATURES) {
		if (error.includes(sig)) return null;
	}

	// Unknown failure mode → fail-closed (R27 default)
	return null;
}
