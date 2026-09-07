import os from "node:os";
import path from "node:path";
import {
	resolveNodeCutoverClosureLedgerPath,
	resolveReconcilerStateDirectory,
} from "../src/modules/reconciliation/reconciler-paths.ts";
import { inspectNodeCutoverState } from "../src/utils/node-cutover-preflight.ts";

const turnlockRunRoot =
	process.env.TURNLOCK_RUN_DIR_ROOT ??
	path.join(os.homedir(), ".turnlock", "runs");
const runsDirectory = path.join(turnlockRunRoot, "git-commits-push-tl");
const orderStateDirectory = resolveReconcilerStateDirectory(process.env);
const closureLedgerPath = resolveNodeCutoverClosureLedgerPath(process.env);

try {
	const report = inspectNodeCutoverState({
		closureLedgerPath,
		nowEpochMs: Date.now(),
		orderStateDirectory,
		runsDirectory,
	});
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = report.ready ? 0 : 1;
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`Node cutover preflight failed: ${message}\n`);
	process.exitCode = 2;
}
