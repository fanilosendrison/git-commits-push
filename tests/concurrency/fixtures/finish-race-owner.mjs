/**
 * Concurrency fixture — race finish/request against the same SQLite database.
 *
 * Environment:
 *   RECONCILER_STATE_DIR   state directory holding reconciler.sqlite
 *   RECONCILER_OWNED_FILE  owner writes `{pid,token,generation}` here after acquiring
 *   RECONCILER_GO_FINISH   owner waits for this file before finalizing its pass
 *   RECONCILER_RESULT_FILE owner appends its finish decision here
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(fixtureDirectory, "../../..");

const reconcilerDb = await import(
	pathToFileURL(
		path.join(
			skillDirectory,
			"src",
			"modules",
			"reconciliation",
			"reconciler-db.ts",
		),
	).href
);
const reconciler = await import(
	pathToFileURL(
		path.join(
			skillDirectory,
			"src",
			"modules",
			"reconciliation",
			"reconciler.ts",
		),
	).href
);

function waitForFile(filePath, timeoutMs = 120_000) {
	const deadline = Date.now() + timeoutMs;
	const signal = new Int32Array(new SharedArrayBuffer(4));
	while (!existsSync(filePath)) {
		if (Date.now() > deadline) {
			process.stderr.write(
				`fixture watchdog: ${filePath} did not appear within ${timeoutMs}ms\n`,
			);
			process.exit(4);
		}
		Atomics.wait(signal, 0, 0, 20);
	}
}

const stateDirectory = process.env.RECONCILER_STATE_DIR;
const ownedFile = process.env.RECONCILER_OWNED_FILE;
const goFinishFile = process.env.RECONCILER_GO_FINISH;
const resultFile = process.env.RECONCILER_RESULT_FILE;

if (!stateDirectory || !ownedFile || !goFinishFile || !resultFile) {
	process.stderr.write(
		"RECONCILER_STATE_DIR, RECONCILER_OWNED_FILE, RECONCILER_GO_FINISH and RECONCILER_RESULT_FILE are required\n",
	);
	process.exit(2);
}

const token = randomBytes(16).toString("hex");
const processIdentity = reconciler.readProcessStartIdentity(process.pid);
if (!processIdentity) throw new Error("cannot read fixture process identity");
const db = reconcilerDb.openReconcilerDb(
	reconcilerDb.resolveReconcilerDbPath(stateDirectory),
);
try {
	const registration = reconciler.registerReconciliationRequest(db, {
		token,
		pid: process.pid,
		bootEpochMs: reconciler.currentBootEpochMs(),
		processIdentity,
		callerName: "Finish Race Owner",
		originAgent: "test",
		nowEpochMs: Date.now(),
	});
	if (registration.kind !== "OWNER") {
		process.stderr.write("finish-race-owner expected to acquire ownership\n");
		process.exit(3);
	}
	writeFileSync(
		ownedFile,
		JSON.stringify({
			pid: process.pid,
			token,
			generation: registration.generation,
		}),
	);
	waitForFile(goFinishFile);
	const finish = reconciler.finishReconciliationPass(db, {
		generation: registration.generation,
		nowEpochMs: Date.now(),
		pid: process.pid,
		success: true,
		token,
	});
	appendFileSync(
		resultFile,
		`${JSON.stringify({
			pid: process.pid,
			token,
			decision: finish.decision,
			completedGeneration: finish.completedGeneration,
			nextGeneration: finish.decision === "CONTINUE" ? finish.generation : null,
		})}\n`,
	);
} finally {
	db.close();
}
