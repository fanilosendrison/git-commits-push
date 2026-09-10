import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	authorizeActiveExecutionStart,
	clearActiveExecution,
	currentBootEpochMs,
	finishReconciliationPass,
	heartbeatReconciler,
	ReconcilerFencedError,
	readProcessStartIdentity,
	registerActiveExecution,
	registerReconciliationRequest,
	releaseReconciliationOwnership,
} from "../../src/modules/reconciliation/reconciler.ts";
import {
	openReconcilerDb,
	POSIX_EXECUTION_BOUNDARY_KIND,
	readReconcilerState,
	resolveReconcilerDbPath,
} from "../../src/modules/reconciliation/reconciler-db.ts";

const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const EXECUTION_A = "execution-a";
const EXECUTION_B = "execution-b";

describe("durable active execution transitions", () => {
	let stateDirectory: string;
	let db: ReturnType<typeof openReconcilerDb>;

	beforeEach(() => {
		stateDirectory = fs.mkdtempSync(
			path.join(os.tmpdir(), "reconciler-active-execution-"),
		);
		db = openReconcilerDb(resolveReconcilerDbPath(stateDirectory));
	});

	afterEach(() => {
		db.close();
		fs.rmSync(stateDirectory, { force: true, recursive: true });
	});

	function registerOwner(token: string, processIdentity: string) {
		return registerReconciliationRequest(db, {
			bootEpochMs: currentBootEpochMs(),
			callerName: `Owner ${token}`,
			nowEpochMs: Date.now(),
			originAgent: "test",
			pid: process.pid,
			processIdentity,
			token,
		});
	}

	function registerExecution(
		ownerToken: string,
		executionToken: string,
		generation: number,
	) {
		return registerActiveExecution(db, {
			executionBoundaryKind: POSIX_EXECUTION_BOUNDARY_KIND,
			executionGroupId: process.pid,
			executionPid: process.pid,
			executionProcessIdentity: `identity-${executionToken}`,
			executionToken,
			generation,
			ownerPid: process.pid,
			ownerToken,
		});
	}

	test("EXEC-INV-2 | register precedes durable start authorization", () => {
		const identity = readProcessStartIdentity(process.pid) ?? "owner-identity";
		const owner = registerOwner(OWNER_A, identity);
		assert.strictEqual(owner.kind, "OWNER");
		const execution = registerExecution(OWNER_A, EXECUTION_A, 1);
		assert.strictEqual(execution.state, "REGISTERED");
		assert.strictEqual(
			authorizeActiveExecutionStart(db, {
				executionToken: EXECUTION_A,
				ownerPid: process.pid,
				ownerToken: OWNER_A,
			}),
			true,
		);
		assert.strictEqual(
			readReconcilerState(db).activeExecution?.state,
			"START_AUTHORIZED",
		);
	});

	test("EXEC-INV-1/6/11 | a live execution blocks a second execution, finish, and release", () => {
		const identity = readProcessStartIdentity(process.pid) ?? "owner-identity";
		registerOwner(OWNER_A, identity);
		registerExecution(OWNER_A, EXECUTION_A, 1);
		assert.throws(
			() => registerExecution(OWNER_A, EXECUTION_B, 1),
			ReconcilerFencedError,
		);
		assert.throws(
			() =>
				finishReconciliationPass(db, {
					generation: 1,
					nowEpochMs: Date.now(),
					pid: process.pid,
					success: true,
					token: OWNER_A,
				}),
			/active execution remains registered/u,
		);
		assert.strictEqual(
			releaseReconciliationOwnership(db, {
				pid: process.pid,
				token: OWNER_A,
			}),
			false,
		);
	});

	test("EXEC-INV-3/4 | owner recovery preserves the old execution until exact clearing", () => {
		registerOwner(OWNER_A, "deliberately-mismatched-owner-identity");
		registerExecution(OWNER_A, EXECUTION_A, 1);

		const identity =
			readProcessStartIdentity(process.pid) ?? "owner-b-identity";
		const recovery = registerOwner(OWNER_B, identity);
		assert.strictEqual(recovery.kind, "OWNER");
		if (recovery.kind !== "OWNER") return;
		assert.strictEqual(recovery.requiresExecutionRecovery, true);
		assert.strictEqual(recovery.generation, 2);
		const preserved = readReconcilerState(db).activeExecution;
		assert.strictEqual(preserved?.token, EXECUTION_A);
		assert.strictEqual(preserved?.ownerToken, OWNER_A);
		assert.strictEqual(preserved?.generation, 1);

		assert.strictEqual(
			clearActiveExecution(db, {
				executionToken: EXECUTION_A,
				ownerPid: process.pid,
				ownerToken: OWNER_B,
			}),
			true,
		);
		assert.strictEqual(readReconcilerState(db).activeExecution, null);
	});

	test("EXEC-INV-5 | stale owner and execution tokens cannot mutate replacement execution", () => {
		registerOwner(OWNER_A, "deliberately-mismatched-owner-identity");
		registerExecution(OWNER_A, EXECUTION_A, 1);
		const identity =
			readProcessStartIdentity(process.pid) ?? "owner-b-identity";
		registerOwner(OWNER_B, identity);
		clearActiveExecution(db, {
			executionToken: EXECUTION_A,
			ownerPid: process.pid,
			ownerToken: OWNER_B,
		});
		registerExecution(OWNER_B, EXECUTION_B, 2);

		assert.throws(
			() =>
				clearActiveExecution(db, {
					executionToken: EXECUTION_A,
					ownerPid: process.pid,
					ownerToken: OWNER_A,
				}),
			ReconcilerFencedError,
		);
		assert.strictEqual(
			clearActiveExecution(db, {
				executionToken: EXECUTION_A,
				ownerPid: process.pid,
				ownerToken: OWNER_B,
			}),
			false,
		);
		assert.strictEqual(
			heartbeatReconciler(db, {
				nowEpochMs: Date.now(),
				pid: process.pid,
				token: EXECUTION_A,
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
					token: OWNER_A,
				}),
			ReconcilerFencedError,
		);
		assert.strictEqual(
			readReconcilerState(db).activeExecution?.token,
			EXECUTION_B,
		);
	});
});
