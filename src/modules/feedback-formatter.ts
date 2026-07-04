/**
 * src/modules/feedback-formatter.ts — Phase 5: Feedback formatting for the LLM prompt
 *
 * Extracts the feedback rendering logic from the bridge into a pure, testable function.
 * Plan ref: Phase 5 — Replace feedback formatting block
 */

import type { Feedback } from "../types.ts";

/**
 * Format a Feedback object into a prompt block for the LLM.
 * Returns an empty string if no feedback is provided.
 *
 * The output contains:
 *   - Error list with [KIND] prefix, → Resolution, → Affected files
 *   - committed_shas section (already landed commits)
 *   - pending_files section (remaining work)
 *   - <remaining-diff> block (if payloadDiff provided and pending_files exist)
 *   - previous_commit rolling history
 *
 * @param feedback - The Feedback object from queueRetry (may be undefined)
 * @param payloadDiff - The diff content from CommitJobPayload.diff (used for <remaining-diff>)
 */
export function formatFeedbackBlock(
	feedback?: Feedback,
	payloadDiff?: string,
): string {
	if (!feedback) return "";

	const lines: string[] = [];

	lines.push("");
	lines.push("--- FEEDBACK FROM PREVIOUS ATTEMPT(S) ---");
	lines.push("Your previous plan(s) were rejected. Fix the issues below:");
	lines.push("");

	// 1. Error list
	for (const err of feedback.errors) {
		lines.push(`[${err.kind.toUpperCase()}] ${err.message}`);
		if (err.resolution_hint) {
			lines.push(`  → Resolution: ${err.resolution_hint}`);
		}
		if (err.files?.length) {
			lines.push(`  → Affected files: ${err.files.join(", ")}`);
		}
		lines.push("");
	}

	// 2. Already committed SHAs
	if (feedback.committed_shas?.length) {
		lines.push("Already committed (DO NOT re-include these files):");
		for (const entry of feedback.committed_shas) {
			lines.push(`  - ${entry.sha.slice(0, 7)}: ${entry.files.join(", ")}`);
		}
		lines.push("");
	}

	// 3. Pending files with remaining diff
	if (feedback.pending_files?.length) {
		lines.push("Pending files (MUST be covered by the new plan):");
		for (const f of feedback.pending_files) {
			lines.push(`  - ${f}`);
		}
		lines.push("");
		// <remaining-diff> block — reconstructed diff for pending files
		if (payloadDiff) {
			lines.push("<remaining-diff>");
			lines.push(payloadDiff);
			lines.push("</remaining-diff>");
			lines.push("");
		}
	} else if (feedback.committed_shas?.length) {
		// All work done — instruct to return []
		lines.push(
			"No pending files remain. Return an empty array [] if all work is covered by committed_shas above.",
		);
		lines.push("");
	}

	// 4. Previous attempt history
	if (feedback.previous_commit) {
		lines.push("Previous attempt(s) (full plan, in order):");
		lines.push(feedback.previous_commit);
		lines.push("");
	}

	// 5. Closing instruction
	lines.push("Generate a NEW JSON array that resolves all listed errors.");
	lines.push("");

	return lines.join("\n");
}
