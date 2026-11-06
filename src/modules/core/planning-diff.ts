import { execSync } from "node:child_process";
import type { Settings } from "../../types.ts";
import { readCreationStagedStat } from "../git/creation-diff.ts";

/** Apply the existing diff cap without changing the full validated diff/hash binding. */
export function preparePlanningDiff(
	diff: string,
	repository: string,
	settings: Settings,
	creation: boolean,
): string {
	const maxDiff = settings.maxDiffChars ?? 3_000_000;
	if (diff.length <= maxDiff) return diff;
	let statFallback = "";
	try {
		statFallback = creation
			? readCreationStagedStat(repository)
			: execSync("git diff --cached --stat", {
					cwd: repository,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				}).toString();
		// Preserve the prior execSync stat fallback's default 1 MiB output limit.
		if (creation && Buffer.byteLength(statFallback, "utf8") > 1024 * 1024)
			statFallback = "";
	} catch {
		/* The complete validated binding remains unchanged if stat is unavailable. */
	}
	return (
		diff.slice(0, maxDiff) +
		`\n\n### DIFF TRUNCATED — ${diff.length} chars total, showing first ${maxDiff} chars ###` +
		`\n\n### FULL FILE LIST (git diff --stat) ###\n${statFallback}`
	);
}
