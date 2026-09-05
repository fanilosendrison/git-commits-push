import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DatabaseSync,
	type DatabaseSync as DatabaseSyncType,
} from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	currentBootEpochMs,
	finishReconciliationPass,
	heartbeatReconciler,
	ReconcilerFencedError,
	type RegisterReconciliationOptions,
	readProcessStartIdentity,
	registerReconciliationRequest,
	releaseReconciliationOwnership,
} from "../../src/modules/reconciliation/reconciler.ts";
import {
	openReconcilerDb,
	readReconcilerState,
	resolveReconcilerDbPath,
} from "../../src/modules/reconciliation/reconciler-db.ts";

interface FabricatedOwnerRow {
	readonly requestedGeneration: number;
	readonly completedGeneration: number;
	readonly runningGeneration: number;
	readonly ownerToken: string;
	readonly ownerPid: number;
	readonly ownerBootEpochMs: number;
	readonly ownerProcessIdentity?: string;
	readonly heartbeatAtEpochMs: number;
}

describe("reconciler state machine", () => {
	let stateDir: string;
	let db: DatabaseSyncType;

	beforeEach(() => {
		stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "reconciler-sm-"));
		db = openReconcilerDb(resolveReconcilerDbPath(stateDir));
	});

	afterEach(() => {
		db.close();
		fs.rmSync(stateDir, { recursive: true, force: true });
	});

	function options(
		overrides: Partial<RegisterReconciliationOptions> = {},
	): RegisterReconciliationOptions {
		return {
			bootEpochMs: currentBootEpochMs(),
			processIdentity:
				readProcessStartIdentity(process.pid) ?? "test-process-identity",
			callerName: "Unit Test Agent",
			nowEpochMs: Date.now(),
			originAgent: "test",
			pid: process.pid,
			token: randomUUID(),
			...overrides,
		};
	}

	/** Spawns a short-lived child and returns its (now dead) pid. */
	function deadPid(): number {
		const result = spawnSync(process.execPath, ["-e", "0"], {
			encoding: "utf-8",
		});
		assert.strictEqual(result.status, 0);
		assert.ok(result.pid !== undefined);
		return result.pid;
	}

	function fabricateOwnerRow(row: FabricatedOwnerRow): void {
		const raw = new DatabaseSync(resolveReconcilerDbPath(stateDir));
		try {
			raw.exec("BEGIN IMMEDIATE");
			raw
				.prepare(
					`UPDATE reconciler_state SET
					requested_generation = ?,
					completed_generation = ?,
					running_generation = ?,
					owner_token = ?,
					owner_pid = ?,
					owner_boot_epoch_ms = ?,
					owner_process_identity = ?,
					owner_caller_name = 'Fabricated Owner',
					owner_origin_agent = 'test',
					owner_session_id = NULL,
					heartbeat_at_epoch_ms = ?
				WHERE singleton_id = 1`,
				)
				.run(
					row.requestedGeneration,
					row.completedGeneration,
					row.runningGeneration,
					row.ownerToken,
					row.ownerPid,
					row.ownerBootEpochMs,
					row.ownerProcessIdentity ??
						readProcessStartIdentity(row.ownerPid) ??
						"missing-process-identity",
					row.heartbeatAtEpochMs,
				);
			raw.exec("COMMIT");
		} catch (error) {
			raw.exec("ROLLBACK");
			throw error;
		} finally {
			raw.close();
		}
	}

	test("U2 | first request atomically acquires ownership", () => {
		const registration = registerReconciliationRequest(db, options());
		assert.strictEqual(registration.kind, "OWNER");
		assert.strictEqual(registration.recovered, false);
		assert.strictEqual(registration.generation, 1);
		assert.strictEqual(registration.completedGeneration, 0);

		const state = readReconcilerState(db);
		assert.strictEqual(state.requestedGeneration, 1);
		assert.strictEqual(state.completedGeneration, 0);
		assert.strictEqual(state.runningGeneration, 1);
		assert.notStrictEqual(state.ownerToken, null);
		assert.notStrictEqual(state.ownerPid, null);
	});

	test("U3 | concurrent requests coalesce without touching the owner", () => {
		const first = registerReconciliationRequest(
			db,
			options({ callerName: "Owner Agent" }),
		);
		assert.strictEqual(first.kind, "OWNER");
		const ownerToken = readReconcilerState(db).ownerToken;

		const second = registerReconciliationRequest(
			db,
			options({ token: randomUUID(), callerName: "Caller B" }),
		);
		assert.strictEqual(second.kind, "COALESCED");
		if (second.kind !== "COALESCED") return;
		assert.strictEqual(second.generation, 2);

		const third = registerReconciliationRequest(
			db,
			options({ token: randomUUID(), callerName: "Caller C" }),
		);
		assert.strictEqual(third.kind, "COALESCED");
		if (third.kind !== "COALESCED") return;
		assert.strictEqual(third.generation, 3);

		const state = readReconcilerState(db);
		assert.strictEqual(state.requestedGeneration, 3);
		assert.strictEqual(state.runningGeneration, 1);
		assert.strictEqual(state.ownerToken, ownerToken);
		assert.strictEqual(state.ownerCallerName, "Owner Agent");
	});

	test("U4 | successful completion with no newer request releases ownership", () => {
		const registrationOptions = options();
		const registration = registerReconciliationRequest(db, registrationOptions);
		assert.strictEqual(registration.kind, "OWNER");
		if (registration.kind !== "OWNER") return;
		const finish = finishReconciliationPass(db, {
			generation: 1,
			nowEpochMs: Date.now(),
			pid: process.pid,
			success: true,
			token: registrationOptions.token,
		});
		assert.strictEqual(finish.decision, "STOP_SUCCESS");
		assert.strictEqual(finish.completedGeneration, 1);

		const state = readReconcilerState(db);
		assert.strictEqual(state.requestedGeneration, 1);
		assert.strictEqual(state.completedGeneration, 1);
		assert.strictEqual(state.runningGeneration, null);
		assert.strictEqual(state.ownerToken, null);
		assert.strictEqual(state.ownerPid, null);
		assert.strictEqual(state.heartbeatAtEpochMs, null);
	});

	test("U5 | successful completion with newer requests keeps ownership", () => {
		const registration = registerReconciliationRequest(db, options());
		assert.strictEqual(registration.kind, "OWNER");
		if (registration.kind !== "OWNER") return;
		registerReconciliationRequest(db, options({ token: randomUUID() }));
		registerReconciliationRequest(db, options({ token: randomUUID() }));
		const ownerToken = readReconcilerState(db).ownerToken;

		const finish = finishReconciliationPass(db, {
			generation: 1,
			nowEpochMs: Date.now(),
			pid: process.pid,
			success: true,
			token: ownerToken ?? "missing",
		});
		assert.strictEqual(finish.decision, "CONTINUE");
		if (finish.decision !== "CONTINUE") return;
		assert.strictEqual(finish.generation, 3);
		assert.strictEqual(finish.completedGeneration, 1);

		const state = readReconcilerState(db);
		assert.strictEqual(state.requestedGeneration, 3);
		assert.strictEqual(state.completedGeneration, 1);
		assert.strictEqual(state.runningGeneration, 3);
		assert.strictEqual(state.ownerToken, ownerToken);
	});

	test("U6 | failure without newer request releases and stays pending", () => {
		const registrationOptions = options();
		const registration = registerReconciliationRequest(db, registrationOptions);
		assert.strictEqual(registration.kind, "OWNER");
		if (registration.kind !== "OWNER") return;
		const finish = finishReconciliationPass(db, {
			generation: 1,
			nowEpochMs: Date.now(),
			pid: process.pid,
			success: false,
			token: registrationOptions.token,
		});
		assert.strictEqual(finish.decision, "STOP_FAILED");
		assert.strictEqual(finish.completedGeneration, 0);

		const state = readReconcilerState(db);
		assert.strictEqual(state.requestedGeneration, 1);
		assert.strictEqual(state.completedGeneration, 0);
		assert.strictEqual(state.runningGeneration, null);
		assert.strictEqual(state.ownerToken, null);
	});

	test("U7 | failure with newer request keeps ownership for a fresh pass", () => {
		const registration = registerReconciliationRequest(db, options());
		assert.strictEqual(registration.kind, "OWNER");
		if (registration.kind !== "OWNER") return;
		registerReconciliationRequest(db, options({ token: randomUUID() }));
		const ownerToken = readReconcilerState(db).ownerToken;

		const finish = finishReconciliationPass(db, {
			generation: 1,
			nowEpochMs: Date.now(),
			pid: process.pid,
			success: false,
			token: ownerToken ?? "missing",
		});
		assert.strictEqual(finish.decision, "CONTINUE");
		if (finish.decision !== "CONTINUE") return;
		assert.strictEqual(finish.generation, 2);

		const state = readReconcilerState(db);
		assert.strictEqual(state.completedGeneration, 0);
		assert.strictEqual(state.requestedGeneration, 2);
		assert.strictEqual(state.runningGeneration, 2);
		assert.strictEqual(state.ownerToken, ownerToken);
	});

	test("U8 | an obsolete owner token cannot mutate coordinator state", () => {
		const registration = registerReconciliationRequest(db, options());
		assert.strictEqual(registration.kind, "OWNER");
		if (registration.kind !== "OWNER") return;
		const oldToken = readReconcilerState(db).ownerToken ?? "old";
		const takeover = {
			completedGeneration: 0,
			heartbeatAtEpochMs: Date.now(),
			ownerBootEpochMs: currentBootEpochMs(),
			ownerPid: deadPid(),
			ownerToken: "new-owner-token",
			requestedGeneration: 2,
			runningGeneration: 2,
		};
		fabricateOwnerRow(takeover);

		assert.strictEqual(
			heartbeatReconciler(db, {
				nowEpochMs: Date.now(),
				pid: process.pid,
				token: oldToken,
			}),
			false,
		);
		assert.strictEqual(
			releaseReconciliationOwnership(db, {
				pid: process.pid,
				token: oldToken,
			}),
			false,
		);
		assert.throws(
			() =>
				finishReconciliationPass(db, {
					generation: 1,
					nowEpochMs: Date.now(),
					pid: process.pid,
					success: true,
					token: oldToken,
				}),
			(error) => {
				assert.ok(error instanceof ReconcilerFencedError);
				return true;
			},
		);
		const state = readReconcilerState(db);
		assert.strictEqual(state.ownerToken, "new-owner-token");
		assert.strictEqual(state.completedGeneration, 0);
	});

	test("U9 | dead-owner recovery preserves pending generations", () => {
		const previousRequested = 5;
		const previousCompleted = 2;
		fabricateOwnerRow({
			completedGeneration: previousCompleted,
			heartbeatAtEpochMs: Date.now() - 60_000,
			ownerBootEpochMs: currentBootEpochMs(),
			ownerPid: deadPid(),
			ownerToken: "dead-owner-token",
			requestedGeneration: previousRequested,
			runningGeneration: previousRequested,
		});

		const registration = registerReconciliationRequest(
			db,
			options({ token: "recovering-token" }),
		);
		assert.strictEqual(registration.kind, "OWNER");
		if (registration.kind !== "OWNER") return;
		assert.strictEqual(registration.recovered, true);
		assert.strictEqual(registration.generation, previousRequested + 1);
		assert.strictEqual(registration.completedGeneration, previousCompleted);

		const state = readReconcilerState(db);
		assert.strictEqual(state.requestedGeneration, previousRequested + 1);
		assert.strictEqual(state.completedGeneration, previousCompleted);
		assert.strictEqual(state.runningGeneration, previousRequested + 1);
		assert.strictEqual(state.ownerToken, "recovering-token");
		assert.strictEqual(state.ownerPid, process.pid);
	});

	test("U10 | live process identity survives old heartbeat and boot-clock drift", () => {
		const previousRequested = 3;
		fabricateOwnerRow({
			completedGeneration: 1,
			heartbeatAtEpochMs: Date.now() - 3_600_000,
			ownerBootEpochMs: currentBootEpochMs() - 9_000_000,
			ownerPid: process.pid,
			ownerToken: "live-owner-token",
			requestedGeneration: previousRequested,
			runningGeneration: previousRequested,
		});

		const registration = registerReconciliationRequest(
			db,
			options({ token: randomUUID(), callerName: "Caller D" }),
		);
		assert.strictEqual(registration.kind, "COALESCED");
		if (registration.kind !== "COALESCED") return;
		assert.strictEqual(registration.generation, previousRequested + 1);

		const state = readReconcilerState(db);
		assert.strictEqual(state.requestedGeneration, previousRequested + 1);
		assert.strictEqual(state.runningGeneration, previousRequested);
		assert.strictEqual(state.ownerToken, "live-owner-token");
	});

	test("U10b | reused PID with a different process identity is recoverable", () => {
		const previousRequested = 4;
		fabricateOwnerRow({
			completedGeneration: 1,
			heartbeatAtEpochMs: Date.now() - 1_000,
			ownerBootEpochMs: currentBootEpochMs(),
			ownerProcessIdentity: "different-process-start",
			ownerPid: process.pid,
			ownerToken: "reused-pid-token",
			requestedGeneration: previousRequested,
			runningGeneration: previousRequested,
		});

		const registration = registerReconciliationRequest(
			db,
			options({ token: "new-boot-token" }),
		);
		assert.strictEqual(registration.kind, "OWNER");
		if (registration.kind !== "OWNER") return;
		assert.strictEqual(registration.recovered, true);
		const state = readReconcilerState(db);
		assert.strictEqual(state.ownerToken, "new-boot-token");
	});
});
