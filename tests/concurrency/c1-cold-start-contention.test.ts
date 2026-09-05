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

const CHILD_COUNT = 32;
const BARRIER_TIMEOUT_MILLISECONDS = 90_000;
const RESULT_TIMEOUT_MILLISECONDS = 60_000;

interface RegisterResultLine {
	readonly pid: number;
	readonly token: string;
	readonly kind: "OWNER" | "COALESCED";
	readonly generation: number;
	readonly recovered: boolean;
	readonly completedGeneration: number | null;
	readonly observedRequested: number;
	readonly observedOwnerToken: string | null;
}

describe("C1 — cold-start contention", () => {
	let stateDir: string;
	let children: ChildProcess[];

	beforeEach(() => {
		stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c1-contention-"));
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
	 * while the parent is blocked in a barrier poll can never emit `close`
	 * before a listener exists.
	 */
	function spawnChild(
		command: string,
		env: Record<string, string>,
	): { child: ChildProcess; closed: Promise<number | null> } {
		const child = spawn(process.execPath, [command], {
			cwd: testDirectory,
			env: { ...process.env, ...env },
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

	function sleep(milliseconds: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, milliseconds));
	}

	test("C1-01 | 32 simultaneous registrations yield exactly one owner", async () => {
		const barrierFile = path.join(stateDir, "barrier");
		const readyDirectory = path.join(stateDir, "ready");
		const keepAliveFile = path.join(stateDir, "keep-alive");
		const resultFile = path.join(stateDir, "results.jsonl");
		fs.mkdirSync(readyDirectory, { recursive: true });

		const childRecords: Array<{
			child: ChildProcess;
			closed: Promise<number | null>;
			stderr: string;
		}> = [];
		for (let index = 0; index < CHILD_COUNT; index++) {
			const { child, closed } = spawnChild(REGISTER_FIXTURE, {
				RECONCILER_BARRIER_FILE: barrierFile,
				RECONCILER_CALLER_NAME: `contender-${index}`,
				RECONCILER_KEEP_ALIVE_FILE: keepAliveFile,
				RECONCILER_READY_FILE: path.join(readyDirectory, `ready-${index}`),
				RECONCILER_RESULT_FILE: resultFile,
				RECONCILER_STATE_DIR: stateDir,
			});
			const record = { child, closed, stderr: "" };
			child.stderr?.on("data", (chunk: Buffer) => {
				record.stderr += chunk.toString("utf-8");
			});
			childRecords.push(record);
		}

		// Wait until every child has reported ready, then release the barrier.
		const deadline = Date.now() + BARRIER_TIMEOUT_MILLISECONDS;
		while (
			fs.readdirSync(readyDirectory).length < CHILD_COUNT &&
			Date.now() < deadline
		) {
			await sleep(20);
		}
		const readyCount = fs.readdirSync(readyDirectory).length;
		assert.strictEqual(
			readyCount,
			CHILD_COUNT,
			`all children must reach the barrier; stderr=${childRecords
				.filter((record) => record.stderr.length > 0)
				.map((record) => `${String(record.child.pid)}:${record.stderr}`)
				.join(" | ")}`,
		);
		fs.writeFileSync(barrierFile, "");

		// Wait until every child has written its registration result. The
		// winner stays alive (keep-alive) so losers cannot recover a dead
		// owner during the assertion.
		const resultDeadline = Date.now() + RESULT_TIMEOUT_MILLISECONDS;
		while (
			(!fs.existsSync(resultFile) ||
				readResultLines(resultFile).length < CHILD_COUNT) &&
			Date.now() < resultDeadline
		) {
			await sleep(20);
		}
		const results = readResultLines(resultFile);
		assert.strictEqual(results.length, CHILD_COUNT);

		const owners = results.filter((line) => line.kind === "OWNER");
		const coalesced = results.filter((line) => line.kind === "COALESCED");
		assert.strictEqual(owners.length, 1);
		assert.strictEqual(coalesced.length, CHILD_COUNT - 1);
		const owner = owners[0];
		assert.ok(owner);
		assert.strictEqual(owner.recovered, false);

		const generations = results
			.map((line) => line.generation)
			.sort((a, b) => a - b);
		assert.deepStrictEqual(
			generations,
			Array.from({ length: CHILD_COUNT }, (_, index) => index + 1),
		);

		// One owner token for the whole contention.
		assert.strictEqual(
			new Set(results.map((line) => line.token)).size,
			CHILD_COUNT,
		);
		const observedTokens = new Set(
			results.map((line) => line.observedOwnerToken),
		);
		assert.strictEqual(observedTokens.size, 1);

		const db = openReconcilerDb(resolveReconcilerDbPath(stateDir));
		try {
			const state = readReconcilerState(db);
			assert.strictEqual(state.requestedGeneration, CHILD_COUNT);
			assert.strictEqual(state.completedGeneration, 0);
			// Coalesced requests never advance the running generation: the
			// owner keeps working on the generation it claimed.
			assert.strictEqual(state.runningGeneration, owner.generation);
			assert.strictEqual(state.ownerPid, owner.pid);
			assert.strictEqual(state.ownerToken, owner.token);
		} finally {
			db.close();
		}

		// No child may have hit SQLITE_BUSY or any unhandled error.
		for (const record of childRecords) {
			assert.ok(
				!record.stderr.includes("SQLITE_BUSY"),
				`child ${record.child.pid} hit SQLITE_BUSY: ${record.stderr}`,
			);
		}

		// Release the winner and verify every child exited cleanly.
		fs.writeFileSync(keepAliveFile, "");
		const exitCodes = await Promise.all(
			childRecords.map((record) => record.closed),
		);
		for (const exitCode of exitCodes) {
			assert.strictEqual(exitCode, 0);
		}
	});
});
