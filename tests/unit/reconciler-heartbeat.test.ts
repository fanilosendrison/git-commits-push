import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	currentBootEpochMs,
	finishReconciliationPass,
	heartbeatReconciler,
	readProcessStartIdentity,
	registerReconciliationRequest,
} from "../../src/modules/reconciliation/reconciler.ts";
import {
	openReconcilerDb,
	readReconcilerState,
	resolveReconcilerDbPath,
} from "../../src/modules/reconciliation/reconciler-db.ts";

describe("reconciler bounded state and heartbeat", () => {
	let stateDirectory: string;
	let db: ReturnType<typeof openReconcilerDb>;

	beforeEach(() => {
		stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "reconciler-hb-"));
		db = openReconcilerDb(resolveReconcilerDbPath(stateDirectory));
	});

	afterEach(() => {
		db.close();
		fs.rmSync(stateDirectory, { recursive: true, force: true });
	});

	function register(token: string = randomUUID()) {
		return registerReconciliationRequest(db, {
			bootEpochMs: currentBootEpochMs(),
			callerName: "Heartbeat Test",
			nowEpochMs: Date.now(),
			originAgent: "test",
			pid: process.pid,
			processIdentity:
				readProcessStartIdentity(process.pid) ?? "test-process-identity",
			token,
		});
	}

	test("U11 | scheduler state stays bounded to a singleton row", () => {
		const cycles = 2_000;
		for (let cycle = 0; cycle < cycles; cycle++) {
			const token = randomUUID();
			const registration = register(token);
			assert.strictEqual(registration.kind, "OWNER");
			if (registration.kind !== "OWNER") return;
			const finish = finishReconciliationPass(db, {
				generation: registration.generation,
				nowEpochMs: Date.now(),
				pid: process.pid,
				success: true,
				token,
			});
			assert.strictEqual(finish.decision, "STOP_SUCCESS");
		}
		const state = readReconcilerState(db);
		assert.strictEqual(state.requestedGeneration, cycles);
		assert.strictEqual(state.completedGeneration, cycles);
		const raw = new DatabaseSync(resolveReconcilerDbPath(stateDirectory));
		try {
			const tables = raw
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
				)
				.all()
				.map((row) => (row as { name: string }).name);
			assert.deepStrictEqual(tables, ["reconciler_state"]);
			const count = raw
				.prepare("SELECT COUNT(*) AS n FROM reconciler_state")
				.get() as { n: number };
			assert.strictEqual(count.n, 1);
		} finally {
			raw.close();
		}
	});

	test("heartbeat is token-fenced and updates only the owner's row", () => {
		const registration = register("hb-token");
		assert.strictEqual(registration.kind, "OWNER");
		const before = readReconcilerState(db).heartbeatAtEpochMs;
		assert.strictEqual(
			heartbeatReconciler(db, {
				nowEpochMs: Date.now() + 4_000,
				pid: process.pid,
				token: "stale-token",
			}),
			false,
		);
		assert.strictEqual(readReconcilerState(db).heartbeatAtEpochMs, before);
		assert.strictEqual(
			heartbeatReconciler(db, {
				nowEpochMs: Date.now() + 5_000,
				pid: process.pid,
				token: "hb-token",
			}),
			true,
		);
		const after = readReconcilerState(db).heartbeatAtEpochMs;
		assert.ok(after !== null && before !== null && after >= before);
	});
});
