import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	openReconcilerDb,
	readReconcilerState,
	resolveReconcilerDbPath,
} from "../../src/modules/reconciliation/reconciler-db.ts";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const REGISTER_FIXTURE = path.join(
	testDirectory,
	"fixtures",
	"register-request.mjs",
);

interface RegisterResultLine {
	readonly pid: number;
	readonly token: string;
	readonly kind: "OWNER" | "COALESCED";
	readonly generation: number;
	readonly recovered: boolean;
	readonly completedGeneration: number | null;
}

describe("C3 — crashed owner recovery", () => {
	let stateDir: string;
	let children: ChildProcess[];

	beforeEach(() => {
		stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c3-crash-"));
		children = [];
	});

	afterEach(() => {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
			}
		}
		fs.rmSync(stateDir, { recursive: true, force: true });
	});

	function waitForClose(child: ChildProcess): Promise<number | null> {
		return new Promise((resolve) => {
			child.once("close", (code) => resolve(code));
		});
	}

	/**
	 * Attach the close observer immediately at spawn so a child that exits
	 * before the next await can never emit `close` without a listener.
	 */
	function spawnRegistrar(resultFile: string): {
		child: ChildProcess;
		closed: Promise<number | null>;
	} {
		const child = spawn(process.execPath, [REGISTER_FIXTURE], {
			cwd: testDirectory,
			env: {
				...process.env,
				RECONCILER_RESULT_FILE: resultFile,
				RECONCILER_STATE_DIR: stateDir,
			},
			shell: false,
			stdio: ["ignore", "ignore", "pipe"],
		});
		children.push(child);
		return { child, closed: waitForClose(child) };
	}

	function readResultLines(resultFile: string): RegisterResultLine[] {
		return fs
			.readFileSync(resultFile, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as RegisterResultLine);
	}

	test("C3-01 | a dead owner is recovered without erasing pending generations", async () => {
		// First child acquires ownership, persists state, then exits WITHOUT
		// any graceful cleanup — a crash.
		const crashedResultFile = path.join(stateDir, "crashed-results.jsonl");
		const crashed = spawnRegistrar(crashedResultFile);
		assert.strictEqual(await crashed.closed, 0);
		const crashedLines = readResultLines(crashedResultFile);
		assert.strictEqual(crashedLines.length, 1);
		const crashedLine = crashedLines[0] as RegisterResultLine;
		assert.strictEqual(crashedLine.kind, "OWNER");
		assert.strictEqual(crashedLine.generation, 1);
		assert.strictEqual(crashedLine.recovered, false);

		// The crashed child's pid is dead, but the SQLite file and its
		// ownership row survive.
		const dbPath = resolveReconcilerDbPath(stateDir);
		assert.strictEqual(fs.existsSync(dbPath), true);
		const dbAfterCrash = openReconcilerDb(dbPath);
		try {
			const state = readReconcilerState(dbAfterCrash);
			assert.strictEqual(state.requestedGeneration, 1);
			assert.strictEqual(state.completedGeneration, 0);
			assert.strictEqual(state.runningGeneration, 1);
			assert.strictEqual(state.ownerToken, crashedLine.token);
			assert.strictEqual(state.ownerPid, crashedLine.pid);
		} finally {
			dbAfterCrash.close();
		}

		// The next invocation must recover ownership atomically and keep the
		// pending generation durable.
		const recoveryResultFile = path.join(stateDir, "recovery-results.jsonl");
		const recovery = spawnRegistrar(recoveryResultFile);
		assert.strictEqual(await recovery.closed, 0);
		const recoveryLines = readResultLines(recoveryResultFile);
		assert.strictEqual(recoveryLines.length, 1);
		const recoveryLine = recoveryLines[0] as RegisterResultLine;
		assert.strictEqual(recoveryLine.kind, "OWNER");
		assert.strictEqual(recoveryLine.recovered, true);
		assert.strictEqual(recoveryLine.generation, 2);
		assert.strictEqual(recoveryLine.completedGeneration, 0);
		assert.notStrictEqual(recoveryLine.token, crashedLine.token);

		const dbAfterRecovery = openReconcilerDb(dbPath);
		try {
			const state = readReconcilerState(dbAfterRecovery);
			assert.strictEqual(state.requestedGeneration, 2);
			assert.strictEqual(state.completedGeneration, 0);
			assert.strictEqual(state.runningGeneration, 2);
			assert.strictEqual(state.ownerToken, recoveryLine.token);
			assert.strictEqual(state.ownerPid, recoveryLine.pid);
		} finally {
			dbAfterRecovery.close();
		}
	});
});
