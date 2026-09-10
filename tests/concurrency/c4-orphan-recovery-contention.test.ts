import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readProcessStartIdentity } from "../../src/modules/reconciliation/reconciler.ts";
import {
	openReconcilerDb,
	readReconcilerState,
	resolveReconcilerDbPath,
} from "../../src/modules/reconciliation/reconciler-db.ts";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const REGISTER_FIXTURE = path.join(
	testDirectory,
	"fixtures/register-request.mjs",
);
const CONTENDER_COUNT = 16;

interface RegisterResultLine {
	readonly pid: number;
	readonly token: string;
	readonly kind: "OWNER" | "COALESCED";
	readonly generation: number;
	readonly recovered: boolean;
}

describe("C4 — orphan execution recovery contention", () => {
	let stateDirectory: string;
	let children: ChildProcess[];
	let sentinel: ChildProcess | null;

	beforeEach(() => {
		stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "c4-orphan-"));
		children = [];
		sentinel = null;
	});

	afterEach(() => {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
			}
		}
		if (
			sentinel?.pid !== undefined &&
			sentinel.exitCode === null &&
			sentinel.signalCode === null
		) {
			try {
				process.kill(-sentinel.pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
		fs.rmSync(stateDirectory, { force: true, recursive: true });
	});

	function waitForClose(child: ChildProcess): Promise<number | null> {
		return new Promise((resolve) => child.once("close", resolve));
	}

	function waitForFile(filePath: string, timeoutMs = 60_000): Promise<void> {
		return new Promise((resolve, reject) => {
			const deadline = Date.now() + timeoutMs;
			const timer = setInterval(() => {
				if (fs.existsSync(filePath)) {
					clearInterval(timer);
					resolve();
				} else if (Date.now() >= deadline) {
					clearInterval(timer);
					reject(new Error(`timed out waiting for ${filePath}`));
				}
			}, 10);
		});
	}

	test("EXEC-INV-10 | dead owner plus live execution elects one recovery coordinator", {
		skip: process.platform !== "darwin" && process.platform !== "linux",
	}, async () => {
		const dbPath = resolveReconcilerDbPath(stateDirectory);
		const initialized = openReconcilerDb(dbPath);
		initialized.close();
		const dead = spawnSync(process.execPath, ["-e", "0"]);
		assert.ok(dead.pid !== undefined);
		sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: true,
			shell: false,
			stdio: "ignore",
		});
		await new Promise<void>((resolve, reject) => {
			sentinel?.once("spawn", resolve);
			sentinel?.once("error", reject);
		});
		assert.ok(sentinel.pid !== undefined);
		const executionIdentity = readProcessStartIdentity(sentinel.pid);
		assert.ok(executionIdentity);
		const raw = new DatabaseSync(dbPath);
		try {
			raw
				.prepare(
					`UPDATE reconciler_state SET
						requested_generation = 1, running_generation = 1,
						owner_token = 'dead-owner', owner_pid = ?, owner_boot_epoch_ms = 1,
						owner_process_identity = 'dead-owner-identity',
						owner_caller_name = 'dead', owner_origin_agent = 'test',
						heartbeat_at_epoch_ms = 1,
						execution_token = 'execution-a', execution_generation = 1,
						execution_pid = ?, execution_process_identity = ?,
						execution_group_id = ?,
						execution_boundary_kind = 'posix-session-process-group-v1',
						execution_owner_token = 'dead-owner',
						execution_state = 'START_AUTHORIZED'
					 WHERE singleton_id = 1`,
				)
				.run(dead.pid, sentinel.pid, executionIdentity, sentinel.pid);
		} finally {
			raw.close();
		}

		const barrierPath = path.join(stateDirectory, "barrier");
		const readyDirectory = path.join(stateDirectory, "ready");
		const keepAlivePath = path.join(stateDirectory, "keep-alive");
		const resultPath = path.join(stateDirectory, "results.jsonl");
		fs.mkdirSync(readyDirectory);
		const closures: Promise<number | null>[] = [];
		for (let index = 0; index < CONTENDER_COUNT; index++) {
			const child = spawn(process.execPath, [REGISTER_FIXTURE], {
				cwd: testDirectory,
				env: {
					...process.env,
					RECONCILER_BARRIER_FILE: barrierPath,
					RECONCILER_KEEP_ALIVE_FILE: keepAlivePath,
					RECONCILER_READY_FILE: path.join(readyDirectory, String(index)),
					RECONCILER_RESULT_FILE: resultPath,
					RECONCILER_STATE_DIR: stateDirectory,
				},
				shell: false,
				stdio: "ignore",
			});
			children.push(child);
			closures.push(waitForClose(child));
		}
		while (fs.readdirSync(readyDirectory).length < CONTENDER_COUNT) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		fs.writeFileSync(barrierPath, "");
		await waitForFile(resultPath);
		while (
			fs.readFileSync(resultPath, "utf8").trim().split("\n").filter(Boolean)
				.length < CONTENDER_COUNT
		) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const results = fs
			.readFileSync(resultPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as RegisterResultLine);
		assert.strictEqual(
			results.filter(({ kind }) => kind === "OWNER").length,
			1,
		);
		assert.strictEqual(
			results.filter(({ kind }) => kind === "COALESCED").length,
			CONTENDER_COUNT - 1,
		);
		const winner = results.find(({ kind }) => kind === "OWNER");
		assert.strictEqual(winner?.recovered, true);
		const db = openReconcilerDb(dbPath);
		try {
			const state = readReconcilerState(db);
			assert.strictEqual(state.ownerToken, winner?.token);
			assert.strictEqual(state.activeExecution?.token, "execution-a");
			assert.strictEqual(state.activeExecution?.ownerToken, "dead-owner");
			assert.strictEqual(state.requestedGeneration, CONTENDER_COUNT + 1);
		} finally {
			db.close();
		}
		fs.writeFileSync(keepAlivePath, "");
		assert.deepStrictEqual(
			await Promise.all(closures),
			Array.from({ length: CONTENDER_COUNT }, () => 0),
		);
	});
});
