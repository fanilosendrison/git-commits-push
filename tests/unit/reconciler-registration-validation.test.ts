import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
	currentBootEpochMs,
	readProcessStartIdentity,
	registerReconciliationRequest,
} from "../../src/modules/reconciliation/reconciler.ts";
import {
	openReconcilerDb,
	readReconcilerState,
	resolveReconcilerDbPath,
} from "../../src/modules/reconciliation/reconciler-db.ts";

const cleanup: string[] = [];

afterEach(() => {
	for (const directory of cleanup.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("reconciler registration validation", () => {
	test("rejects empty owner identities before advancing generation", () => {
		const stateDirectory = fs.mkdtempSync(
			path.join(os.tmpdir(), "reconciler-registration-validation-"),
		);
		cleanup.push(stateDirectory);
		const db = openReconcilerDb(resolveReconcilerDbPath(stateDirectory));
		try {
			const baseOptions = {
				bootEpochMs: currentBootEpochMs(),
				callerName: "test caller",
				nowEpochMs: Date.now(),
				originAgent: "test",
				pid: process.pid,
				processIdentity:
					readProcessStartIdentity(process.pid) ?? "test-process",
				token: "test-token",
			};
			for (const invalidOptions of [
				{ ...baseOptions, callerName: " " },
				{ ...baseOptions, originAgent: " " },
				{ ...baseOptions, processIdentity: " " },
				{ ...baseOptions, originSessionId: " " },
			]) {
				assert.throws(
					() => registerReconciliationRequest(db, invalidOptions),
					/must not be empty/u,
				);
			}
			const state = readReconcilerState(db);
			assert.strictEqual(state.requestedGeneration, 0);
			assert.strictEqual(state.ownerToken, null);
		} finally {
			db.close();
		}
	});
});
