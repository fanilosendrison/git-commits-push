import type { FeedbackError, RepoReport, RepoState } from "../../types.ts";

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
						kind: r.loopDetected.kind as FeedbackError["kind"],
						planHash: r.loopDetected.planHash,
					}
				: undefined,
		};
	});
}

export function generateReport(repos: Record<string, RepoState>): string {
	const lines: string[] = ["", "=== TURNLOCK EXECUTION REPORT ===", ""];

	for (const [id, state] of Object.entries(repos)) {
		const attempts = state.attempts ?? {};
		const totalRetries = Object.values(attempts).reduce((a, b) => a + b, 0);

		let line = "";
		if (state.status === "SUCCESS") {
			const commitCount = state.committedShas?.length ?? 0;
			const firstCommit = state.commits?.[0]?.commit;
			const commitSummary = firstCommit
				? ` — ${firstCommit.type}: ${firstCommit.description}`
				: "";
			line = `✅ [${id}] Success.${commitSummary}`;
			if (commitCount > 0) {
				line += ` (${commitCount} commit${commitCount > 1 ? "s" : ""})`;
			}
		} else if (state.status === "FAILED") {
			line = `❌ [${id}] Failed.${state.error ?? ""}`;
		} else {
			line = `⚠️ [${id}] Unexpected state: ${state.status}`;
		}
		lines.push(line);

		if (totalRetries > 0) {
			const breakdown = Object.entries(attempts)
				.filter(([, count]) => count > 0)
				.map(([kind, count]) => `${kind}: ${count}`)
				.join(", ");
			lines.push(
				`   🔄 ${totalRetries} retr${totalRetries > 1 ? "ies" : "y"} (${breakdown})`,
			);
		}

		if (state.fallbackAttempted) {
			lines.push(`   ⏫ Fallback model used`);
		}

		if (state.loopDetected) {
			lines.push(`   ⛔ Loop detected (${state.loopDetected.kind})`);
		}

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

export function printReport(repos: Record<string, RepoState>): void {
	process.stderr.write(generateReport(repos));
}
