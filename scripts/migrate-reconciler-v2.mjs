#!/usr/bin/env node
import { resolveReconcilerDbPath } from "../src/modules/reconciliation/reconciler-db.ts";
import { resolveReconcilerStateDirectory } from "../src/modules/reconciliation/reconciler-paths.ts";
import { migrateReconcilerV2Database } from "./reconciler-v2-migration.mjs";

const confirmationFlag = "--confirm-no-live-execution";
const unknownArguments = process.argv
	.slice(2)
	.filter((argument) => argument !== confirmationFlag);
if (unknownArguments.length > 0) {
	throw new Error(
		`Unknown migration arguments: ${unknownArguments.join(", ")}`,
	);
}
const stateDirectory = resolveReconcilerStateDirectory(process.env);
const dbPath = resolveReconcilerDbPath(stateDirectory);
const result = migrateReconcilerV2Database({
	confirmedNoLiveExecution: process.argv.includes(confirmationFlag),
	dbPath,
});
process.stdout.write(`${JSON.stringify({ dbPath, ...result })}\n`);
