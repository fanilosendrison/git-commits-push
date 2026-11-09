import { DatabaseSync } from "node:sqlite";

const [moduleUrl, lockPath, extensionPath] = process.argv.slice(2);
if (!moduleUrl || !lockPath || !process.send) {
	throw new Error("Expected installer module, lock path and IPC channel.");
}
const emit = (type, fields = {}) =>
	process.send?.({
		type,
		pid: process.pid,
		monotonicNs: String(process.hrtime.bigint()),
		...fields,
	});

if (extensionPath) {
	const control = new DatabaseSync(":memory:", { allowExtension: true });
	control.loadExtension(extensionPath);
	control.close();
}

// Observation only: never open/read/close the database file through node:fs.
const nativeExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
	emit("sql-start", { sql, transaction: this.isTransaction });
	try {
		const result = nativeExec.call(this, sql);
		emit("sql-return", { sql, transaction: this.isTransaction });
		return result;
	} catch (error) {
		emit("sql-error", {
			sql,
			errCode: error.errcode,
			transaction: this.isTransaction,
		});
		throw error;
	}
};
const { acquireInstallLock, releaseInstallLock } = await import(moduleUrl);
let owner;
process.on("message", (message) => {
	try {
		if (message === "acquire") {
			owner = acquireInstallLock(lockPath);
			emit("acquired", {
				nonce: owner.nonce,
				processIdentity: owner.processIdentity,
				recovered: owner.recovered,
				transaction: owner.database.isTransaction,
			});
		} else if (message === "release" && owner) {
			releaseInstallLock(lockPath, owner);
			owner = undefined;
			emit("released");
			process.disconnect();
		} else {
			throw new Error("Unexpected installer fixture command.");
		}
	} catch (error) {
		emit("refused", {
			message: error.message,
			causeCode: error.cause?.errcode,
		});
		process.exitCode = 1;
		process.disconnect();
	}
});
emit("prepared");
