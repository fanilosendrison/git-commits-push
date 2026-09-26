import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createLauncherCancellation } from "../../src/modules/reconciliation/launcher-cancellation.ts";
import { runOwnedReconciliation } from "../../src/modules/reconciliation/owned-reconciliation-loop.ts";
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
	retireLegacyGlobalRecovery,
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
			mode: "global",
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
					mode: "global",
					nowEpochMs: Date.now(),
					pid: process.pid,
					success: true,
					token: OWNER_A,
				}),
			/active execution remains registered/u,
		);
		assert.strictEqual(
			releaseReconciliationOwnership(db, {
				mode: "global",
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
		assert.strictEqual(recovery.kind, "RECOVERY_OWNER");
		if (recovery.kind !== "RECOVERY_OWNER") return;
		assert.strictEqual(recovery.recoveryMode, "global");
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

		// Preserve old descriptor -> exact clear -> retire without replay.
		assert.strictEqual(
			retireLegacyGlobalRecovery(db, {
				pid: process.pid,
				token: OWNER_B,
			}),
			true,
		);
		const retired = readReconcilerState(db);
		assert.strictEqual(
			retired.completedGeneration,
			retired.requestedGeneration,
		);
		assert.strictEqual(retired.runningGeneration, null);
		assert.strictEqual(retired.ownerInvocationMode, null);
		assert.strictEqual(retired.activeExecution, null);
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
			() => registerExecution(OWNER_A, "execution-stale", 2),
			ReconcilerFencedError,
		);
		assert.throws(
			() =>
				authorizeActiveExecutionStart(db, {
					executionToken: EXECUTION_B,
					ownerPid: process.pid,
					ownerToken: OWNER_A,
				}),
			ReconcilerFencedError,
		);
		assert.strictEqual(
			authorizeActiveExecutionStart(db, {
				executionToken: EXECUTION_A,
				ownerPid: process.pid,
				ownerToken: OWNER_B,
			}),
			false,
		);
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
				token: OWNER_A,
			}),
			false,
		);
		assert.throws(
			() =>
				finishReconciliationPass(db, {
					generation: 2,
					mode: "global",
					nowEpochMs: Date.now(),
					pid: process.pid,
					success: true,
					token: OWNER_A,
				}),
			ReconcilerFencedError,
		);
		assert.strictEqual(
			releaseReconciliationOwnership(db, {
				mode: "global",
				pid: process.pid,
				token: OWNER_A,
			}),
			false,
		);
		assert.strictEqual(
			readReconcilerState(db).activeExecution?.token,
			EXECUTION_B,
		);
		assert.strictEqual(
			clearActiveExecution(db, {
				executionToken: EXECUTION_B,
				ownerPid: process.pid,
				ownerToken: OWNER_B,
			}),
			true,
		);
		assert.throws(
			() =>
				finishReconciliationPass(db, {
					generation: 2,
					mode: "global",
					nowEpochMs: Date.now(),
					pid: process.pid,
					success: true,
					token: OWNER_A,
				}),
			ReconcilerFencedError,
		);
		assert.strictEqual(
			finishReconciliationPass(db, {
				generation: 2,
				mode: "global",
				nowEpochMs: Date.now(),
				pid: process.pid,
				success: true,
				token: OWNER_B,
			}).decision,
			"STOP_SUCCESS",
		);
	});

	test("legacy global generation arithmetic stays testable through the fenced primitive", () => {
		const identity = readProcessStartIdentity(process.pid) ?? "owner-identity";
		const owner = registerOwner(OWNER_A, identity);
		assert.strictEqual(owner.kind, "OWNER");
		const coalesced = registerOwner(OWNER_B, identity);
		assert.strictEqual(coalesced.kind, "COALESCED");

		// The old generic execution-loop test is replaced by the state-transition
		// primitive because runOwnedReconciliation(global) is non-executable.
		const finish = finishReconciliationPass(db, {
			generation: 1,
			mode: "global",
			nowEpochMs: Date.now(),
			pid: process.pid,
			success: false,
			token: OWNER_A,
		});
		assert.strictEqual(finish.decision, "CONTINUE");
		if (finish.decision !== "CONTINUE") return;
		assert.strictEqual(finish.generation, 2);

		const state = readReconcilerState(db);
		assert.strictEqual(state.requestedGeneration, 2);
		assert.strictEqual(state.completedGeneration, 0);
		assert.strictEqual(state.runningGeneration, 2);
		assert.strictEqual(state.ownerToken, OWNER_A);
	});

	test("EXEC-INV-18 | legacy global execution is impossible before preparation", async () => {
		const identity = readProcessStartIdentity(process.pid) ?? "owner-identity";
		const owner = registerOwner(OWNER_A, identity);
		assert.strictEqual(owner.kind, "OWNER");
		const cancellation = createLauncherCancellation();
		let preparationCalls = 0;
		try {
			await assert.rejects(
				runOwnedReconciliation({
					cancellation,
					compiledApplicationDirectory: stateDirectory,
					db,
					initialGeneration: 1,
					invocationDirectory: stateDirectory,
					mode: "global",
					ownerToken: OWNER_A,
					passthroughArguments: [],
					prepareRuntime: async () => {
						preparationCalls += 1;
						return { exitCode: 0 };
					},
				}),
				(error: unknown) => {
					assert.ok(error instanceof Error);
					assert.match(error.message, /non-executable/);
					assert.match(
						error.message,
						/global recovery must fence and retire without replay/,
					);
					return true;
				},
			);
			assert.strictEqual(preparationCalls, 0);
			const state = readReconcilerState(db);
			assert.strictEqual(state.activeExecution, null);
			assert.strictEqual(state.ownerToken, OWNER_A);
			assert.strictEqual(state.runningGeneration, 1);
		} finally {
			cancellation.removeSignalHandlers();
		}
	});

	test("a targeted runtime preparation failure settles its generation", async () => {
		const identity = readProcessStartIdentity(process.pid) ?? "owner-identity";
		const owner = registerReconciliationRequest(db, {
			bootEpochMs: currentBootEpochMs(),
			callerName: "targeted preparation",
			mode: "targeted",
			nowEpochMs: Date.now(),
			originAgent: "test",
			pid: process.pid,
			processIdentity: identity,
			token: "targeted-prep-token",
		});
		assert.strictEqual(owner.kind, "OWNER");
		const cancellation = createLauncherCancellation();
		try {
			const result = await runOwnedReconciliation({
				cancellation,
				compiledApplicationDirectory: stateDirectory,
				db,
				initialGeneration: 1,
				invocationDirectory: stateDirectory,
				mode: "targeted",
				ownerToken: "targeted-prep-token",
				passthroughArguments: [],
				prepareRuntime: async () => ({ exitCode: 1 }),
			});
			assert.strictEqual(result.exitCode, 1);
			const state = readReconcilerState(db);
			assert.strictEqual(state.requestedGeneration, 1);
			assert.strictEqual(state.completedGeneration, 1);
			assert.strictEqual(state.runningGeneration, null);
			assert.strictEqual(state.ownerToken, null);
			assert.strictEqual(state.ownerInvocationMode, null);
		} finally {
			cancellation.removeSignalHandlers();
		}
	});
});
