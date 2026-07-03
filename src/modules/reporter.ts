/**
 * src/modules/reporter.ts — Phase 5: Generate and print the execution report.
 *
 * Contract:
 *   - generateReport() is a pure function — testable with no side effects.
 *   - printReport() writes to stderr ONLY, never stdout (DC-TURNLOCK §5).
 */
import type { RepoState } from "../types.ts";

/**
 * Generate a human-readable execution report string from the final GlobalState.
 * Pure function — no side effects, no I/O.
 */
export function generateReport(repos: Record<string, RepoState>): string {
	const lines: string[] = ["", "=== TURNLOCK EXECUTION REPORT ===", ""];

	for (const [id, state] of Object.entries(repos)) {
		if (state.status === "SUCCESS") {
			const firstCommit = state.commits?.[0]?.commit;
			const commitSummary = firstCommit
				? ` — ${firstCommit.type}: ${firstCommit.description}`
				: "";
			lines.push(`✅ [${id}] Commit et Push réussis.${commitSummary}`);
		} else if (state.status === "FAILED") {
			const reason = state.error ? ` ${state.error}` : "";
			lines.push(`❌ [${id}] Échec.${reason}`);
		} else {
			// PENDING or RUNNING should not appear in Phase 5 — defensive output
			lines.push(`⚠️  [${id}] État inattendu: ${state.status}`);
		}
	}

	lines.push("");
	lines.push("=================================");
	lines.push("");

	return lines.join("\n");
}

/**
 * Print the execution report to stderr (DC-TURNLOCK: stdout must only contain
 * Turnlock protocol blocks, never human-readable output).
 */
export function printReport(repos: Record<string, RepoState>): void {
	process.stderr.write(generateReport(repos));
}
