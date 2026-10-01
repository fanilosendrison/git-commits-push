/**
 * Concurrency fixture — registers one reconciliation request against a shared
 * SQLite database, optionally behind a deterministic file barrier.
 *
 * Environment:
 *   RECONCILER_STATE_DIR      state directory holding reconciler.sqlite
 *   RECONCILER_READY_FILE     written before waiting at the barrier (optional)
 *   RECONCILER_BARRIER_FILE   wait for this file before registering (optional)
 *   RECONCILER_RESULT_FILE    append one JSON result line (required)
 *   RECONCILER_KEEP_ALIVE_FILE  if owned, stay alive until this exists (optional)
 *   RECONCILER_CALLER_NAME    caller identity recorded in the state row
 *   RECONCILER_MODE           "global" (default) or "targeted"
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
const readyFile = process.env.RECONCILER_READY_FILE;
const barrierFile = process.env.RECONCILER_BARRIER_FILE;
const resultFile = process.env.RECONCILER_RESULT_FILE;
const keepAliveFile = process.env.RECONCILER_KEEP_ALIVE_FILE;

if (!stateDirectory || !resultFile) {
	process.stderr.write(
		"RECONCILER_STATE_DIR and RECONCILER_RESULT_FILE are required\n",
	);
	process.exit(2);
}

mkdirSync(stateDirectory, { recursive: true });
const mode = process.env.RECONCILER_MODE ?? "global";
if (mode !== "global" && mode !== "targeted") {
	process.stderr.write("RECONCILER_MODE must be global or targeted\n");
	process.exit(2);
}
const token = randomBytes(16).toString("hex");
const processIdentity = reconciler.readProcessStartIdentity(process.pid);
if (!processIdentity) throw new Error("cannot read fixture process identity");
if (readyFile) {
	writeFileSync(readyFile, `${process.pid}\n`);
}
if (barrierFile) {
	waitForFile(barrierFile);
}
const db = reconcilerDb.openReconcilerDb(
	reconcilerDb.resolveReconcilerDbPath(stateDirectory),
);
try {
	const registration = reconciler.registerReconciliationRequest(db, {
		token,
		pid: process.pid,
		bootEpochMs: reconciler.currentBootEpochMs(),
		processIdentity,
		mode,
		callerName: process.env.RECONCILER_CALLER_NAME ?? "Concurrency Fixture",
		originAgent: "test",
		nowEpochMs: Date.now(),
	});
	const state = reconcilerDb.readReconcilerState(db);
	let serialized;
	if (registration.kind === "OWNER") {
		serialized = {
			pid: process.pid,
			token,
			kind: registration.kind,
			mode: registration.mode,
			generation: registration.generation,
			recovered: false,
			completedGeneration: registration.completedGeneration,
			observedRequested: state.requestedGeneration,
			observedOwnerToken: state.ownerToken,
		};
	} else if (registration.kind === "COALESCED") {
		serialized = {
			pid: process.pid,
			token,
			kind: registration.kind,
			mode: registration.mode,
			generation: registration.generation,
			recovered: false,
			completedGeneration: null,
			observedRequested: state.requestedGeneration,
			observedOwnerToken: state.ownerToken,
		};
	} else if (registration.kind === "WAIT") {
		serialized = {
			pid: process.pid,
			token,
			kind: registration.kind,
			ownerMode: registration.ownerMode,
			ownerPid: registration.ownerPid,
			ownerCallerName: registration.ownerCallerName,
			runningGeneration: registration.runningGeneration,
			observedRequested: state.requestedGeneration,
			observedOwnerToken: state.ownerToken,
		};
	} else {
		serialized = {
			pid: process.pid,
			token,
			kind: registration.kind,
			recoveryMode: registration.recoveryMode,
			generation: registration.generation,
			recovered: true,
			completedGeneration: registration.completedGeneration,
			previousOwnerPid: registration.previousOwnerPid,
			requiresExecutionRecovery: registration.requiresExecutionRecovery,
			requestSatisfiedByRecovery: registration.requestSatisfiedByRecovery,
			observedRequested: state.requestedGeneration,
			observedOwnerToken: state.ownerToken,
		};
	}
	appendFileSync(resultFile, `${JSON.stringify(serialized)}\n`);
	if (
		(registration.kind === "OWNER" || registration.kind === "RECOVERY_OWNER") &&
		keepAliveFile
	) {
		waitForFile(keepAliveFile);
	}
} finally {
	db.close();
}
