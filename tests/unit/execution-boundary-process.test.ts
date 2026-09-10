import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	classifyExecutionBoundary,
	platformSupportsExecutionBoundary,
	readProcessGroupId,
	terminateExecutionBoundary,
} from "../../src/modules/reconciliation/execution-boundary-process.ts";
import { readProcessStartIdentity } from "../../src/modules/reconciliation/reconciler.ts";
import {
	type ActiveExecutionRecord,
	POSIX_EXECUTION_BOUNDARY_KIND,
} from "../../src/modules/reconciliation/reconciler-db.ts";

function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
	return new Promise((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	});
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function processGroupExistsForTest(groupId: number): boolean {
	try {
		process.kill(-groupId, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

test("leader death with live group members is ambiguous and fails closed", {
	skip: !platformSupportsExecutionBoundary(),
}, async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "execution-leader-death-"),
	);
	const markerPath = path.join(root, "child-pid");
	const leader = spawn(
		process.execPath,
		[
			"-e",
			`const{spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:false,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(markerPath)},String(child.pid));setInterval(()=>{},1000)`,
		],
		{ detached: true, shell: false, stdio: "ignore" },
	);
	await waitForSpawn(leader);
	assert.ok(leader.pid !== undefined);
	const leaderPid = leader.pid;
	try {
		const markerDeadline = Date.now() + 10_000;
		while (!fs.existsSync(markerPath)) {
			assert.ok(Date.now() < markerDeadline, "child marker timed out");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const identity = readProcessStartIdentity(leaderPid);
		assert.ok(identity);
		const closed = new Promise((resolve) => leader.once("close", resolve));
		leader.kill("SIGKILL");
		await closed;
		const execution: ActiveExecutionRecord = {
			boundaryKind: POSIX_EXECUTION_BOUNDARY_KIND,
			generation: 1,
			groupId: leaderPid,
			ownerToken: "former-owner",
			pid: leaderPid,
			processIdentity: identity,
			state: "START_AUTHORIZED" as const,
			token: "leader-dead-execution",
		};
		assert.strictEqual(classifyExecutionBoundary(execution), "ambiguous");
		await assert.rejects(
			terminateExecutionBoundary(execution),
			/ambiguous PID or process-group identity/u,
		);
		assert.strictEqual(processGroupExistsForTest(leaderPid), true);
	} finally {
		try {
			process.kill(-leaderPid, "SIGKILL");
		} catch {
			// The inherited child may already have exited.
		}
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("EXEC-INV-9 | identity mismatch never signals an unrelated live process group", {
	skip: !platformSupportsExecutionBoundary(),
}, async () => {
	const sentinel = spawn(
		process.execPath,
		["-e", "setInterval(() => {}, 1000)"],
		{ detached: true, shell: false, stdio: "ignore" },
	);
	await waitForSpawn(sentinel);
	assert.ok(sentinel.pid !== undefined);
	const sentinelPid = sentinel.pid;
	try {
		assert.strictEqual(readProcessGroupId(sentinelPid), sentinelPid);
		const mismatchedExecution: ActiveExecutionRecord = {
			boundaryKind: POSIX_EXECUTION_BOUNDARY_KIND,
			generation: 1,
			groupId: sentinelPid,
			ownerToken: "former-owner",
			pid: sentinelPid,
			processIdentity: `reused-${randomUUID()}`,
			state: "START_AUTHORIZED" as const,
			token: "old-execution",
		};
		assert.strictEqual(
			classifyExecutionBoundary(mismatchedExecution),
			"ambiguous",
		);
		await assert.rejects(
			terminateExecutionBoundary(mismatchedExecution, {
				confirmationMs: 50,
				graceMs: 50,
			}),
			/ambiguous PID or process-group identity/u,
		);
		assert.strictEqual(processIsAlive(sentinelPid), true);
	} finally {
		try {
			process.kill(-sentinelPid, "SIGKILL");
		} catch {
			// The sentinel may already have exited during assertion cleanup.
		}
	}
});
