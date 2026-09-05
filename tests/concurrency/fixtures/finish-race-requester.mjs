/**
 * Concurrency fixture — the requester side of the finish/request race.
 *
 * The requester pre-opens the database and waits at a gate before
 * registering, so the parent can release the requester's registration and the
 * owner's finish truly simultaneously.
 *
 * Environment:
 *   RECONCILER_STATE_DIR      state directory holding reconciler.sqlite
 *   RECONCILER_OWNED_FILE     wait until the owner fixture has acquired ownership
 *   RECONCILER_READY_FILE     written once the requester is armed at the gate
 *   RECONCILER_GO_REGISTER    the requester registers only after this file exists
 *   RECONCILER_RESULT_FILE    append the registration result here
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
const readyFile = process.env.RECONCILER_READY_FILE;
const goRegisterFile = process.env.RECONCILER_GO_REGISTER;
const resultFile = process.env.RECONCILER_RESULT_FILE;

if (
	!stateDirectory ||
	!ownedFile ||
	!readyFile ||
	!goRegisterFile ||
	!resultFile
) {
	process.stderr.write(
		"RECONCILER_STATE_DIR, RECONCILER_OWNED_FILE, RECONCILER_READY_FILE, RECONCILER_GO_REGISTER and RECONCILER_RESULT_FILE are required\n",
	);
	process.exit(2);
}

waitForFile(ownedFile);

const token = randomBytes(16).toString("hex");
const processIdentity = reconciler.readProcessStartIdentity(process.pid);
if (!processIdentity) throw new Error("cannot read fixture process identity");
const db = reconcilerDb.openReconcilerDb(
	reconcilerDb.resolveReconcilerDbPath(stateDirectory),
);
try {
	writeFileSync(readyFile, `${process.pid}\n`);
	waitForFile(goRegisterFile);
	const registration = reconciler.registerReconciliationRequest(db, {
		token,
		pid: process.pid,
		bootEpochMs: reconciler.currentBootEpochMs(),
		processIdentity,
		callerName: "Finish Race Requester",
		originAgent: "test",
		nowEpochMs: Date.now(),
	});
	appendFileSync(
		resultFile,
		`${JSON.stringify({
			pid: process.pid,
			token,
			kind: registration.kind,
			generation: registration.generation,
			recovered: registration.kind === "OWNER" ? registration.recovered : false,
		})}\n`,
	);
} finally {
	db.close();
}
