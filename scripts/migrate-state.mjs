import os from "node:os";
import path from "node:path";
import { resolveApplicationStateDirectory } from "../src/modules/reconciliation/reconciler-paths.ts";
import { migrateApplicationState } from "./state-migration.mjs";

if (process.env.ORDER_STATE_DIR !== undefined) {
	throw new Error(
		"ORDER_STATE_DIR is set; the configured state location does not require default-state migration.",
	);
}

const sourceRoot = path.join(
	os.homedir(),
	".agents",
	"skills",
	"git-commits-push",
	".state",
);
const targetRoot = resolveApplicationStateDirectory(process.env);
const result = migrateApplicationState({ sourceRoot, targetRoot });
process.stdout.write(
	`${JSON.stringify({ sourceRoot, targetRoot, ...result })}\n`,
);
