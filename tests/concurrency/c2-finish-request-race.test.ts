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
const OWNER_FIXTURE = path.join(
	testDirectory,
	"fixtures",
	"finish-race-owner.mjs",
);
const REQUESTER_FIXTURE = path.join(
	testDirectory,
	"fixtures",
	"finish-race-requester.mjs",
);

interface OwnerResultLine {
	readonly pid: number;
	readonly token: string;
	readonly decision: "CONTINUE" | "STOP_SUCCESS" | "STOP_FAILED";
	readonly completedGeneration: number;
	readonly nextGeneration: number | null;
}

interface RequesterResultLine {
	readonly pid: number;
	readonly token: string;
	readonly kind: "OWNER" | "COALESCED";
	readonly generation: number;
	readonly recovered: boolean;
}

describe("C2 — finish/request handoff race", () => {
	let stateDir: string;
	let children: ChildProcess[];

	beforeEach(() => {
		stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2-handoff-"));
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
	 * Spawn a fixture child and attach the close observer immediately, so a
	 * child that exits while the parent is awaiting its sibling can never
	 * emit `close` before a listener exists.
	 */
	function spawnChild(
		fixture: string,
		env: Record<string, string>,
	): { child: ChildProcess; closed: Promise<number | null> } {
		const child = spawn(process.execPath, [fixture], {
			cwd: testDirectory,
			env: { ...process.env, ...env },
			shell: false,
			stdio: ["ignore", "ignore", "pipe"],
		});
		children.push(child);
		return { child, closed: waitForClose(child) };
	}

	function readLines<T>(filePath: string): T[] {
		return fs
			.readFileSync(filePath, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as T);
	}

	function waitForFile(filePath: string, timeoutMs = 20_000): void {
		const deadline = Date.now() + timeoutMs;
		const signal = new Int32Array(new SharedArrayBuffer(4));
		while (!fs.existsSync(filePath) && Date.now() < deadline) {
			Atomics.wait(signal, 0, 0, 20);
		}
		assert.strictEqual(
			fs.existsSync(filePath),
			true,
			`expected file ${filePath} to appear`,
		);
	}

	test("C2-01 | simultaneous finish and request settle into a valid state", async () => {
		const ownerTokensSeen = new Set<string>();
		const requesterTokensSeen = new Set<string>();
		const MAX_RACE_ITERATIONS = 40;

		for (
			let iteration = 0;
			iteration < MAX_RACE_ITERATIONS &&
			!(ownerTokensSeen.size > 0 && requesterTokensSeen.size > 0);
			iteration++
		) {
			const iterationStateDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "c2-iteration-"),
			);
			try {
				const ownedFile = path.join(iterationStateDir, "owned");
				const goFinishFile = path.join(iterationStateDir, "go-finish");
				const requesterReadyFile = path.join(
					iterationStateDir,
					"requester-ready",
				);
				const goRegisterFile = path.join(iterationStateDir, "go-register");
				const ownerResultFile = path.join(
					iterationStateDir,
					"owner-results.jsonl",
				);
				const requesterResultFile = path.join(
					iterationStateDir,
					"requester-results.jsonl",
				);
				const commonEnv = {
					RECONCILER_STATE_DIR: iterationStateDir,
				};

				const owner = spawnChild(OWNER_FIXTURE, {
					...commonEnv,
					RECONCILER_GO_FINISH: goFinishFile,
					RECONCILER_OWNED_FILE: ownedFile,
					RECONCILER_RESULT_FILE: ownerResultFile,
				});
				waitForFile(ownedFile);

				// Arm the requester at its gate so its registration and the
				// owner's finish are released genuinely simultaneously.
				const requester = spawnChild(REQUESTER_FIXTURE, {
					...commonEnv,
					RECONCILER_GO_REGISTER: goRegisterFile,
					RECONCILER_OWNED_FILE: ownedFile,
					RECONCILER_READY_FILE: requesterReadyFile,
					RECONCILER_RESULT_FILE: requesterResultFile,
				});
				waitForFile(requesterReadyFile);

				// Alternate the release order so neither write transaction
				// enjoys a systematic head start across iterations.
				if (iteration % 2 === 0) {
					fs.writeFileSync(goRegisterFile, "");
					fs.writeFileSync(goFinishFile, "");
				} else {
					fs.writeFileSync(goFinishFile, "");
					fs.writeFileSync(goRegisterFile, "");
				}

				assert.strictEqual(await requester.closed, 0);
				assert.strictEqual(await owner.closed, 0);

				const ownerResult = readLines<OwnerResultLine>(ownerResultFile);
				const requesterResult =
					readLines<RequesterResultLine>(requesterResultFile);
				assert.strictEqual(ownerResult.length, 1);
				assert.strictEqual(requesterResult.length, 1);
				const ownerLine = ownerResult[0] as OwnerResultLine;
				const requesterLine = requesterResult[0] as RequesterResultLine;

				const db = openReconcilerDb(resolveReconcilerDbPath(iterationStateDir));
				try {
					const state = readReconcilerState(db);
					assertNoLostWakeupState(state, iteration);
					if (ownerLine.decision === "CONTINUE") {
						// Outcome A: the old owner consumed the wakeup.
						assert.strictEqual(requesterLine.kind, "COALESCED");
						assert.strictEqual(state.ownerToken, ownerLine.token);
						ownerTokensSeen.add(ownerLine.token);
					} else {
						// Outcome B: the owner released first; the requester
						// became the next owner atomically.
						assert.strictEqual(ownerLine.decision, "STOP_SUCCESS");
						assert.strictEqual(requesterLine.kind, "OWNER");
						assert.strictEqual(requesterLine.recovered, false);
						assert.strictEqual(state.ownerToken, requesterLine.token);
						requesterTokensSeen.add(requesterLine.token);
					}
				} finally {
					db.close();
				}
			} finally {
				fs.rmSync(iterationStateDir, { recursive: true, force: true });
			}
		}

		// Both interleavings must have been observed across the iterations.
		assert.ok(ownerTokensSeen.size > 0, "outcome A never observed");
		assert.ok(requesterTokensSeen.size > 0, "outcome B never observed");
	});

	function assertNoLostWakeupState(
		state: ReturnType<typeof readReconcilerState>,
		iteration: number,
	): void {
		assert.strictEqual(
			state.requestedGeneration,
			2,
			`iteration ${iteration}: requested must be 2`,
		);
		assert.strictEqual(
			state.completedGeneration,
			1,
			`iteration ${iteration}: completed must be 1`,
		);
		assert.strictEqual(
			state.runningGeneration,
			2,
			`iteration ${iteration}: running must be 2`,
		);
		assert.notStrictEqual(
			state.ownerToken,
			null,
			`iteration ${iteration}: a lost wakeup left no owner`,
		);
		assert.notStrictEqual(
			state.ownerPid,
			null,
			`iteration ${iteration}: a lost wakeup left no owner pid`,
		);
	}

	test("C2-02 | requester-first ordering deterministically keeps the owner", async () => {
		const ownedFile = path.join(stateDir, "owned");
		const goFinishFile = path.join(stateDir, "go-finish");
		const requesterReadyFile = path.join(stateDir, "requester-ready");
		const goRegisterFile = path.join(stateDir, "go-register");
		const ownerResultFile = path.join(stateDir, "owner-results.jsonl");
		const requesterResultFile = path.join(stateDir, "requester-results.jsonl");

		const owner = spawnChild(OWNER_FIXTURE, {
			RECONCILER_GO_FINISH: goFinishFile,
			RECONCILER_OWNED_FILE: ownedFile,
			RECONCILER_RESULT_FILE: ownerResultFile,
			RECONCILER_STATE_DIR: stateDir,
		});
		waitForFile(ownedFile);

		// The requester commits its registration before the owner finishes.
		const requester = spawnChild(REQUESTER_FIXTURE, {
			RECONCILER_GO_REGISTER: goRegisterFile,
			RECONCILER_OWNED_FILE: ownedFile,
			RECONCILER_READY_FILE: requesterReadyFile,
			RECONCILER_RESULT_FILE: requesterResultFile,
			RECONCILER_STATE_DIR: stateDir,
		});
		waitForFile(requesterReadyFile);
		fs.writeFileSync(goRegisterFile, "");
		assert.strictEqual(await requester.closed, 0);
		fs.writeFileSync(goFinishFile, "");
		assert.strictEqual(await owner.closed, 0);

		const ownerLine = readLines<OwnerResultLine>(ownerResultFile)[0];
		assert.ok(ownerLine);
		assert.strictEqual(ownerLine.decision, "CONTINUE");
		assert.strictEqual(ownerLine.completedGeneration, 1);
		assert.strictEqual(ownerLine.nextGeneration, 2);

		const requesterLine =
			readLines<RequesterResultLine>(requesterResultFile)[0];
		assert.ok(requesterLine);
		assert.strictEqual(requesterLine.kind, "COALESCED");

		const db = openReconcilerDb(resolveReconcilerDbPath(stateDir));
		try {
			const state = readReconcilerState(db);
			assert.strictEqual(state.ownerToken, ownerLine.token);
			assert.strictEqual(state.runningGeneration, 2);
		} finally {
			db.close();
		}
	});

	test("C2-03 | owner-first ordering deterministically hands ownership over", async () => {
		const ownedFile = path.join(stateDir, "owned");
		const goFinishFile = path.join(stateDir, "go-finish");
		const requesterReadyFile = path.join(stateDir, "requester-ready");
		const goRegisterFile = path.join(stateDir, "go-register");
		const ownerResultFile = path.join(stateDir, "owner-results.jsonl");
		const requesterResultFile = path.join(stateDir, "requester-results.jsonl");

		const owner = spawnChild(OWNER_FIXTURE, {
			RECONCILER_GO_FINISH: goFinishFile,
			RECONCILER_OWNED_FILE: ownedFile,
			RECONCILER_RESULT_FILE: ownerResultFile,
			RECONCILER_STATE_DIR: stateDir,
		});
		waitForFile(ownedFile);

		// The owner finalizes (and releases) before the requester registers.
		fs.writeFileSync(goFinishFile, "");
		assert.strictEqual(await owner.closed, 0);

		const requester = spawnChild(REQUESTER_FIXTURE, {
			RECONCILER_GO_REGISTER: goRegisterFile,
			RECONCILER_OWNED_FILE: ownedFile,
			RECONCILER_READY_FILE: requesterReadyFile,
			RECONCILER_RESULT_FILE: requesterResultFile,
			RECONCILER_STATE_DIR: stateDir,
		});
		waitForFile(requesterReadyFile);
		fs.writeFileSync(goRegisterFile, "");
		assert.strictEqual(await requester.closed, 0);

		const ownerLine = readLines<OwnerResultLine>(ownerResultFile)[0];
		assert.ok(ownerLine);
		assert.strictEqual(ownerLine.decision, "STOP_SUCCESS");

		const requesterLine =
			readLines<RequesterResultLine>(requesterResultFile)[0];
		assert.ok(requesterLine);
		assert.strictEqual(requesterLine.kind, "OWNER");
		assert.strictEqual(requesterLine.recovered, false);
		assert.strictEqual(requesterLine.generation, 2);

		const db = openReconcilerDb(resolveReconcilerDbPath(stateDir));
		try {
			const state = readReconcilerState(db);
			assert.strictEqual(state.completedGeneration, 1);
			assert.strictEqual(state.requestedGeneration, 2);
			assert.strictEqual(state.runningGeneration, 2);
			assert.strictEqual(state.ownerToken, requesterLine.token);
		} finally {
			db.close();
		}
	});
});
