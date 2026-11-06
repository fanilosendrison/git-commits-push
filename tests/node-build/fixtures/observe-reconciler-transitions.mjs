import { ChildProcess } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// Test-only NODE_OPTIONS observer. No production module imports this fixture.
const tracePath = process.env.GCP_TEST_RECONCILER_TRACE_PATH;
const databasePath = process.env.GCP_TEST_RECONCILER_TRACE_DB;
if (tracePath && databasePath) {
	const originalExec = DatabaseSync.prototype.exec;
	const originalPrepare = DatabaseSync.prototype.prepare;
	const originalKill = process.kill.bind(process);
	const selected = new WeakMap();
	const connections = new Set();
	const originalSpawn = ChildProcess.prototype.spawn;
	let startReceipt = null;
	const transactions = new WeakMap();
	let transactionCount = 0;
	let sequence = 0;
	const buffered = [];

	function event(type, data) {
		const record = { type, pid: process.pid, sequence: ++sequence, ...data };
		if (transactionCount > 0) buffered.push(record);
		else {
			try {
				appendFileSync(tracePath, `${JSON.stringify(record)}\n`);
			} catch {
				/* Missing evidence must fail the oracle, not alter runtime decisions. */
			}
		}
		return record;
	}
	function flush() {
		if (transactionCount > 0) return;
		for (const record of buffered.splice(0)) {
			try {
				appendFileSync(tracePath, `${JSON.stringify(record)}\n`);
			} catch {
				/* Evidence is checked independently after execution. */
			}
		}
	}
	function isSelected(database) {
		if (selected.has(database)) return selected.get(database);
		let matches = false;
		try {
			const entry = originalPrepare
				.call(database, "PRAGMA database_list")
				.get();
			matches =
				Boolean(entry?.file) &&
				realpathSync(entry.file) === realpathSync(databasePath);
		} catch {
			/* Other SQLite stores are intentionally outside this observer. */
		}
		selected.set(database, matches);
		if (matches) connections.add(database);
		return matches;
	}
	function snapshot(database) {
		try {
			return (
				originalPrepare
					.call(
						database,
						"SELECT * FROM reconciler_state WHERE singleton_id = 1",
					)
					.get() ?? null
			);
		} catch {
			return null;
		}
	}

	function currentRecord() {
		for (const connection of connections) {
			const value = snapshot(connection);
			if (value) return value;
		}
		return null;
	}
	function committedRecord() {
		if (transactionCount > 0) return null;
		let database;
		try {
			database = new DatabaseSync(databasePath, { readOnly: true });
			return snapshot(database);
		} catch {
			return null;
		} finally {
			database?.close();
		}
	}
	process.on("message", (message) => {
		if (message?.type === "START")
			startReceipt = event("controller_start_receive", {
				token: message.token,
				parentPid: process.ppid,
				record: committedRecord(),
			});
	});
	ChildProcess.prototype.spawn = function observedSpawn(options) {
		// Later arguments include the supervisor path passed to the controller;
		// classify the actual Node entrypoint, not arbitrary path operands.
		const entrypoint = options.args?.[1] ?? "";
		const controller = /(?:^|[\\/])execution-controller\.(?:js|ts)$/u.test(
			entrypoint,
		);
		const supervisor = /(?:^|[\\/])node-supervisor\.(?:js|ts)$/u.test(
			entrypoint,
		);
		const atSpawn = supervisor
			? {
					token: startReceipt?.token ?? null,
					receipt: startReceipt,
					record: committedRecord(),
				}
			: null;
		const result = originalSpawn.call(this, options);
		if (supervisor)
			event("supervisor_spawn", { ...atSpawn, childPid: this.pid });
		if (controller && this.send) {
			const send = this.send;
			this.send = function observedSend(message, ...rest) {
				if (message?.type === "START")
					event("controller_start_send", {
						token: message.token,
						controllerPid: this.pid,
						transactionOpen: transactionCount > 0,
						record: committedRecord(),
					});
				return send.call(this, message, ...rest);
			};
		}
		return result;
	};
	process.kill = function observedKill(pid, signal) {
		const record = signal === 0 ? currentRecord() : null;
		const transactionOpen = transactionCount > 0;
		try {
			const result = originalKill(pid, signal);
			if (signal === 0)
				event("process_probe", {
					target: pid,
					exists: true,
					record,
					transactionOpen,
				});
			return result;
		} catch (error) {
			if (signal === 0)
				event("process_probe", {
					target: pid,
					exists: error.code !== "ESRCH",
					code: error.code,
					record,
					transactionOpen,
				});
			throw error;
		}
	};
	DatabaseSync.prototype.exec = function observedExec(sql) {
		if (!isSelected(this)) return originalExec.call(this, sql);
		const statement = sql.trim().replace(/;$/u, "").toUpperCase();
		if (statement === "BEGIN IMMEDIATE") {
			const result = originalExec.call(this, sql);
			transactionCount++;
			transactions.set(this, {
				before: snapshot(this),
				beginSequence: ++sequence,
			});
			return result;
		}
		if (statement === "COMMIT" && transactions.has(this)) {
			// Read the transaction's exact proposed row, commit it, then emit outside
			// the transaction. No file/child/Git work is added while SQLite is locked.
			const { before, beginSequence } = transactions.get(this);
			const after = snapshot(this);
			const result = originalExec.call(this, sql);
			transactions.delete(this);
			transactionCount--;
			flush();
			event("coordinator_commit", { before, after, beginSequence });
			return result;
		}
		if (statement === "ROLLBACK" && transactions.has(this)) {
			const result = originalExec.call(this, sql);
			transactions.delete(this);
			transactionCount--;
			flush();
			return result;
		}
		return originalExec.call(this, sql);
	};
}
