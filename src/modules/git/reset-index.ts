import { execSync } from "node:child_process";

/** Best-effort index reset before a retry; failures remain diagnostic only. */
export function resetIndexForRetry(repository: string): void {
	try {
		execSync("git reset HEAD", {
			cwd: repository,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		process.stderr.write(
			"[git-commits-push-tl] orchestrator reset HEAD failed during retry prep: " +
				`${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
}
