import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectNodeCutoverState } from "../dist/skills/git-commits-push/src/utils/node-cutover-preflight.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");
const turnlockRunRoot =
	process.env.TURNLOCK_RUN_DIR_ROOT ??
	path.join(os.homedir(), ".turnlock", "runs");
const runsDirectory = path.join(turnlockRunRoot, "git-commits-push-tl");
const orderStateDirectory =
	process.env.ORDER_STATE_DIR ?? path.join(skillDirectory, ".state", "orders");
const closureLedgerPath =
	process.env.GCP_NODE_CUTOVER_CLOSURE_LEDGER ??
	path.join(skillDirectory, ".state", "node-cutover-closures.json");

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
