import assert from "node:assert/strict";
import fs, { type PathLike } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
	acquireInstallLock,
	releaseInstallLock,
} from "../../src/modules/installation/install-lock.ts";
import { readProcessStartIdentity } from "../../src/modules/reconciliation/process-identity.ts";

let root: string;
let lockPath: string;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(tmpdir(), "gcp-lock-fencing-"));
	lockPath = path.join(root, "install.lock");
});
afterEach(() => {
	mock.restoreAll();
	syncBuiltinESMExports();
	fs.rmSync(root, { recursive: true, force: true });
});
function writeRecord(content: string): void {
	fs.writeFileSync(`${lockPath}.owner`, content, { mode: 0o600 });
	fs.chmodSync(`${lockPath}.owner`, 0o600);
}
function staleRecord(): string {
	return JSON.stringify({
		version: 1,
		nonce: "a".repeat(32),
		pid: process.pid,
		processIdentity: "a different process incarnation",
	});
}

for (const kind of ["nonce", "pid", "processIdentity", "malformed"] as const) {
	test(`refuses release with changed ${kind} and retains the held transaction`, () => {
		const owner = acquireInstallLock(lockPath);
		const original = fs.readFileSync(`${lockPath}.owner`, "utf8");
		const replacement =
			kind === "malformed"
				? "{"
				: JSON.stringify({
						version: 1,
						nonce: owner.nonce,
						pid: owner.pid,
						processIdentity: owner.processIdentity,
						[kind]: kind === "pid" ? owner.pid + 1 : "b".repeat(32),
					});
		try {
			writeRecord(replacement);
			assert.throws(
				() => releaseInstallLock(lockPath, owner),
				/ownership changed|malformed/,
			);
			assert.equal(owner.database.isTransaction, true);
			assert.equal(fs.readFileSync(`${lockPath}.owner`, "utf8"), replacement);
		} finally {
			writeRecord(original);
			releaseInstallLock(lockPath, owner);
		}
	});
}

test("recovers a reused PID only when its process-start identity differs", () => {
	const previous = staleRecord();
	writeRecord(previous);
	const owner = acquireInstallLock(lockPath);
	try {
		assert.equal(owner.recovered, true);
		assert.equal(owner.pid, process.pid);
		assert.equal(owner.processIdentity, readProcessStartIdentity(process.pid));
		const archive = fs
			.readdirSync(root)
			.find((name) => name.includes(".stale-"));
		assert.ok(archive);
		assert.equal(fs.readFileSync(path.join(root, archive), "utf8"), previous);
	} finally {
		releaseInstallLock(lockPath, owner);
	}
});

test("a live PID with unreadable birth metadata never enables recovery", () => {
	const pid = Number.MAX_SAFE_INTEGER;
	const record = JSON.stringify({
		version: 1,
		nonce: "a".repeat(32),
		pid,
		processIdentity: "unknown",
	});
	writeRecord(record);
	const original = process.kill;
	mock.method(
		process,
		"kill",
		(target: number, signal?: NodeJS.Signals | number) => {
			if (target === pid && signal === 0) return true;
			return original(target, signal);
		},
	);
	assert.throws(() => acquireInstallLock(lockPath), /installer is active/);
	assert.equal(fs.readFileSync(`${lockPath}.owner`, "utf8"), record);
	assert.equal(
		fs.readdirSync(root).some((name) => name.includes(".stale-")),
		false,
	);
});

for (const content of [
	"{",
	"",
	"x".repeat(4097),
	JSON.stringify({ version: 1 }),
	JSON.stringify({
		version: 1,
		nonce: "a".repeat(32),
		pid: 0,
		processIdentity: "invalid",
	}),
]) {
	test(`preserves invalid owner metadata (${content.length} bytes)`, () => {
		writeRecord(content);
		assert.throws(() => acquireInstallLock(lockPath), /owner|record/);
		assert.equal(fs.readFileSync(`${lockPath}.owner`, "utf8"), content);
		assert.equal(
			fs.readdirSync(root).some((name) => name.includes(".stale-")),
			false,
		);
	});
}

for (const entry of ["database", "owner"] as const) {
	for (const kind of ["symlink", "directory", "mode", "uid"] as const) {
		test(`refuses unsafe ${entry} ${kind} without replacing it`, () => {
			const candidate = entry === "database" ? lockPath : `${lockPath}.owner`;
			const target = path.join(root, "preserved-target");
			fs.writeFileSync(target, staleRecord(), { mode: 0o600 });
			if (kind === "symlink") fs.symlinkSync(target, candidate);
			else if (kind === "directory") fs.mkdirSync(candidate);
			else {
				fs.writeFileSync(candidate, entry === "owner" ? staleRecord() : "", {
					mode: 0o600,
				});
				fs.chmodSync(candidate, kind === "mode" ? 0o644 : 0o600);
				if (kind === "uid") {
					const lstat = fs.lstatSync;
					// Fault injection only: an unprivileged test cannot chown to another UID.
					mock.method(fs, "lstatSync", (file: PathLike) => {
						const stats = lstat(file);
						if (file === candidate) stats.uid += 1;
						return stats;
					});
					syncBuiltinESMExports();
				}
			}
			assert.throws(
				() => acquireInstallLock(lockPath),
				/private physical file/,
			);
			assert.equal(fs.readFileSync(target, "utf8"), staleRecord());
			assert.equal(
				fs.readdirSync(root).some((name) => name.includes(".stale-")),
				false,
			);
		});
	}
}

test("refuses a corrupt database without archiving the stale record", () => {
	fs.writeFileSync(lockPath, "not a sqlite database", { mode: 0o600 });
	const original = staleRecord();
	writeRecord(original);
	assert.throws(() => acquireInstallLock(lockPath), /installer lock database/);
	assert.equal(fs.readFileSync(`${lockPath}.owner`, "utf8"), original);
});

test("metadata publication failure rolls back and closes the native transaction", () => {
	const failure = new Error("injected owner link failure");
	mock.method(fs, "linkSync", () => {
		throw failure;
	});
	syncBuiltinESMExports();
	assert.throws(
		() => acquireInstallLock(lockPath),
		(error) => error === failure,
	);
	assert.equal(fs.existsSync(`${lockPath}.owner`), false);
	assert.equal(
		fs.readdirSync(root).some((name) => name.includes(".candidate-")),
		false,
	);
	mock.restoreAll();
	syncBuiltinESMExports();
	const next = acquireInstallLock(lockPath);
	releaseInstallLock(lockPath, next);
});

test("reports COMMIT failure while still closing the native transaction", () => {
	const owner = acquireInstallLock(lockPath);
	const failure = new Error("injected COMMIT failure");
	const exec = DatabaseSync.prototype.exec;
	mock.method(
		DatabaseSync.prototype,
		"exec",
		function (this: DatabaseSync, sql: string) {
			if (sql === "COMMIT") throw failure;
			return exec.call(this, sql);
		},
	);
	assert.throws(
		() => releaseInstallLock(lockPath, owner),
		(error) => error === failure,
	);
	assert.equal(fs.existsSync(`${lockPath}.owner`), false);
	assert.throws(() => owner.database.prepare("SELECT 1"), /not open|closed/);
	mock.restoreAll();
	const next = acquireInstallLock(lockPath);
	releaseInstallLock(lockPath, next);
});

test("an expired recovery deadline grants no owner metadata", () => {
	const original = staleRecord();
	writeRecord(original);
	let observations = 0;
	mock.method(performance, "now", () => (observations++ === 0 ? 0 : 5_001));
	assert.throws(() => acquireInstallLock(lockPath), /deadline expired/);
	assert.equal(fs.readFileSync(`${lockPath}.owner`, "utf8"), original);
	assert.equal(
		fs.readdirSync(root).some((name) => name.includes(".stale-")),
		false,
	);
	mock.restoreAll();
	const next = acquireInstallLock(lockPath);
	releaseInstallLock(lockPath, next);
});

test("preserves a changed recovery epoch before any schema or owner effect", () => {
	writeRecord(staleRecord());
	const changed = JSON.stringify({
		version: 1,
		nonce: "c".repeat(32),
		pid: process.pid,
		processIdentity: "another incarnation",
	});
	const exec = DatabaseSync.prototype.exec;
	const statements: string[] = [];
	mock.method(
		DatabaseSync.prototype,
		"exec",
		function (this: DatabaseSync, sql: string) {
			statements.push(sql);
			const result = exec.call(this, sql);
			if (sql === "BEGIN EXCLUSIVE") writeRecord(changed);
			return result;
		},
	);
	assert.throws(() => acquireInstallLock(lockPath), /superseded/);
	assert.equal(fs.readFileSync(`${lockPath}.owner`, "utf8"), changed);
	assert.equal(
		statements.some((sql) => sql.includes("CREATE TABLE")),
		false,
	);
	assert.equal(
		fs.readdirSync(root).some((name) => name.includes(".stale-")),
		false,
	);
	mock.restoreAll();
	const next = acquireInstallLock(lockPath);
	releaseInstallLock(lockPath, next);
});

test("a failed ROLLBACK still closes the native acquisition after a metadata failure", () => {
	const failure = new Error("injected owner publication failure");
	mock.method(fs, "linkSync", () => {
		throw failure;
	});
	syncBuiltinESMExports();
	const exec = DatabaseSync.prototype.exec;
	mock.method(
		DatabaseSync.prototype,
		"exec",
		function (this: DatabaseSync, sql: string) {
			if (sql === "ROLLBACK") throw new Error("injected ROLLBACK failure");
			return exec.call(this, sql);
		},
	);
	assert.throws(
		() => acquireInstallLock(lockPath),
		(error) => error === failure,
	);
	mock.restoreAll();
	syncBuiltinESMExports();
	const next = acquireInstallLock(lockPath);
	releaseInstallLock(lockPath, next);
});

test("does not hide close failure after a successful COMMIT", () => {
	const owner = acquireInstallLock(lockPath);
	const close = DatabaseSync.prototype.close;
	const failure = new Error("injected close outcome");
	mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
		close.call(this);
		throw failure;
	});
	assert.throws(
		() => releaseInstallLock(lockPath, owner),
		(error) => error === failure,
	);
	assert.equal(fs.existsSync(`${lockPath}.owner`), false);
	mock.restoreAll();
	const next = acquireInstallLock(lockPath);
	releaseInstallLock(lockPath, next);
});
