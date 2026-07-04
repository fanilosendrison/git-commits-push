/**
 * src/modules/reporter.ts — Phase 5/8: Generate and print the execution report.
 *
 * Contract:
 *   - buildReport() is a pure function — extracts structured RepoReport[] from RepoState
 *   - generateReport() is a pure function — renders the report to a string
 *   - printReport() writes to stderr ONLY, never stdout (DC-TURNLOCK §5)
 *
 * Phase 8 update (R39, R62):
 *   - buildReport() surfaces committedShas, per-kind attempts, totalRetries, loopDetected
 *   - generateReport() renders the new fields
 */

import type { RepoReport, RepoState } from "../types.ts";

/**
 * Build a structured RepoReport array from the final repos state.
 * Pure function — no side effects, no I/O.
 *
 * Plan ref: Phase 8 — §8.0 Reporter contract (R39, R62)
 */
export function buildReport(repos: Record<string, RepoState>): RepoReport[] {
	return Object.entries(repos).map(([_id, r]) => {
		const attempts = r.attempts ?? {};
		const totalRetries = Object.values(attempts).reduce((a, b) => a + b, 0);
		return {
			repository: r.repository,
			status: r.status,
			error: r.error,
			committedShas: r.committedShas ?? [],
			attempts,
			totalRetries,
			loopDetected: r.loopDetected
				? {
						kind: r.loopDetected.kind as RepoReport["loopDetected"]["kind"],
						planHash: r.loopDetected.planHash,
					}
				: undefined,
		};
	});
}

/**
 * Generate a human-readable execution report string from the final repos state.
 * Pure function — no side effects, no I/O.
 */
export function generateReport(repos: Record<string, RepoState>): string {
	const lines: string[] = ["", "=== TURNLOCK EXECUTION REPORT ===", ""];

	for (const [id, state] of Object.entries(repos)) {
		const attempts = state.attempts ?? {};
		const totalRetries = Object.values(attempts).reduce((a, b) => a + b, 0);

		// Status icon + id
		let line = "";
		if (state.status === "SUCCESS") {
			const commitCount = state.committedShas?.length ?? 0;
			const firstCommit = state.commits?.[0]?.commit;
			const commitSummary = firstCommit
				? ` — ${firstCommit.type}: ${firstCommit.description}`
				: "";
			line = `✅ [${id}] Succès.${commitSummary}`;
			if (commitCount > 0) {
				line += ` (${commitCount} commit${commitCount > 1 ? "s" : ""})`;
			}
		} else if (state.status === "FAILED") {
			const reason = state.error ? ` ${state.error}` : "";
			line = `❌ [${id}] Échec.${reason}`;
		} else if (state.status === "ESCALATED") {
			line = `⚠️ [${id}] Escaladé. ${state.error ?? "Remonté à l'agent parent."}`;
		} else {
			line = `⚠️ [${id}] État inattendu: ${state.status}`;
		}
		lines.push(line);

		// Retry breakdown
		if (totalRetries > 0) {
			const breakdown = Object.entries(attempts)
				.filter(([, count]) => count > 0)
				.map(([kind, count]) => `${kind}: ${count}`)
				.join(", ");
			lines.push(
				`   🔄 ${totalRetries} tentative${totalRetries > 1 ? "s" : ""} de reprise (${breakdown})`,
			);
		}

		// Loop detection
		if (state.loopDetected) {
			lines.push(`   ⛔ Boucle détectée (${state.loopDetected.kind})`);
		}

		// Committed SHAs
		if (state.committedShas && state.committedShas.length > 0) {
			for (const cs of state.committedShas) {
				lines.push(`   📦 ${cs.sha.slice(0, 7)}: ${cs.files.join(", ")}`);
			}
		}

		lines.push("");
	}

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
