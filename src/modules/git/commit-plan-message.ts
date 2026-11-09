import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitExecArgs } from "./git-exec.ts";
import { assertNoPreparedMerge } from "./prepared-merge-source.ts";

/** Historical plan-message commit effect; never consume newly appeared merge state. */
export function commitPlanMessage(repository: string, message: string): void {
	const directory = mkdtempSync(path.join(tmpdir(), "gcp-plan-message-"));
	try {
		const file = path.join(directory, "message");
		writeFileSync(file, message, { mode: 0o600 });
		assertNoPreparedMerge(repository);
		gitExecArgs(["commit", "--file", file, "--no-verify"], repository);
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			/* Preserve historical best-effort cleanup; never erase a completed commit acknowledgement. */
		}
	}
}
