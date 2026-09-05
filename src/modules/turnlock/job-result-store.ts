import * as fs from "node:fs";
import * as path from "node:path";
import type { CommitJobResult } from "../../types.ts";

/** Persist one result in its Turnlock-managed job result directory. */
export function writeCommitJobResult(
	resultPath: string,
	result: CommitJobResult,
): void {
	fs.mkdirSync(path.dirname(resultPath), { recursive: true });
	fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf-8");
}
