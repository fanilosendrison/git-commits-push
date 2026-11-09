import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	buildInstallLockSchedule,
	crossInstallLockPromotions,
	type InstallLockEvent,
	InstallLockProcess,
} from "./install-lock-process.ts";

/** Same independent real-process oracles for source, compiled and installed code. */
export function registerInstallLockRecoveryTests(moduleUrl: string): void {
	describe("installer stale-lock safety and progress", () => {
		let root: string;
		let lockPath: string;
		let library: string;
		let actors: InstallLockProcess[];
		beforeEach(async () => {
			root = await mkdtemp(path.join(tmpdir(), "gcp-lock-recovery-"));
			lockPath = path.join(root, "install.lock");
			actors = [];
			library = buildInstallLockSchedule(root);
		});
		afterEach(async () => {
			await Promise.all(actors.map((actor) => actor.terminate()));
			await rm(root, { recursive: true, force: true });
		});

		function actor(role?: "A" | "B"): InstallLockProcess {
			const child = new InstallLockProcess(
				moduleUrl,
				lockPath,
				role ? { library, role } : undefined,
			);
			actors.push(child);
			return child;
		}

		async function acquire(
			child: InstallLockProcess,
		): Promise<InstallLockEvent> {
			await child.waitFor("prepared");
			child.send("acquire");
			return child.waitFor("acquired");
		}

		async function release(child: InstallLockProcess): Promise<void> {
			child.send("release");
			await child.waitFor("released");
			assert.deepEqual(await child.waitForExit(), { code: 0, signal: null });
		}

		async function seedDeadOwner(warm = false): Promise<void> {
			if (warm) {
				const database = new DatabaseSync(lockPath);
				database.exec(
					"CREATE TABLE install_lock_schema(version INTEGER NOT NULL)",
				);
				database.close();
				await chmod(lockPath, 0o600);
			}
			const seed = actor();
			const acquired = await acquire(seed);
			assert.equal(acquired.pid, seed.child.pid);
			await seed.terminate();
			assert.deepEqual(await seed.result, { code: null, signal: "SIGKILL" });
			assert.throws(() => process.kill(acquired.pid, 0), { code: "ESRCH" });
		}

		async function assertOwner(
			child: InstallLockProcess,
			event: InstallLockEvent,
		): Promise<string> {
			assert.equal(event.transaction, true);
			assert.equal(event.pid, child.child.pid);
			assert.equal(process.kill(event.pid, 0), true);
			const bytes = await readFile(`${lockPath}.owner`, "utf8");
			const record: unknown = JSON.parse(bytes);
			assert.deepEqual(record, {
				version: 1,
				nonce: event.nonce,
				pid: event.pid,
				processIdentity: event.processIdentity,
			});
			return bytes;
		}

		async function preparedPair(): Promise<
			[InstallLockProcess, InstallLockProcess]
		> {
			const a = actor("A");
			const b = actor("B");
			await Promise.all([a.waitFor("prepared"), b.waitFor("prepared")]);
			return [a, b];
		}

		async function assertRefusedWhileHeld(
			a: InstallLockProcess,
			b: InstallLockProcess,
		): Promise<void> {
			const acquired = await a.waitFor("acquired");
			assert.equal(acquired.recovered, true);
			const before = await assertOwner(a, acquired);
			await b.waitFor("refused");
			assert.deepEqual(await b.waitForExit(), { code: 1, signal: null });
			assert.equal(
				b.events.filter((event) => event.type === "acquired").length,
				0,
			);
			assert.equal(
				a.events.filter((event) => event.type === "acquired").length,
				1,
			);
			assert.equal(
				a.events.some((event) => event.type === "released"),
				false,
			);
			assert.equal(await readFile(`${lockPath}.owner`, "utf8"), before);
			assert.equal(process.kill(acquired.pid, 0), true);
			assert.ok(
				a.nativeEvents.some((line) => line.includes(" EXCLUSIVE_BUSY 4 5")),
			);
			assert.ok(
				b.nativeEvents.some((line) => line.includes(" RESERVED_BUSY 2 5")),
			);
		}

		for (const warm of [false, true]) {
			test(`settles crossed native promotions with one owner (${warm ? "warm" : "cold"})`, async () => {
				await seedDeadOwner(warm);
				const [a, b] = await preparedPair();
				crossInstallLockPromotions(a, b);
				await assertRefusedWhileHeld(a, b);
				await release(a);
				await assert.rejects(readFile(`${lockPath}.owner`), { code: "ENOENT" });
				const next = actor();
				assert.equal((await acquire(next)).recovered, false);
				await release(next);
			});
		}

		test("refuses an overtaken waiter after the winner releases", async () => {
			await seedDeadOwner();
			const [a, b] = await preparedPair();
			crossInstallLockPromotions(a, b);
			await assertOwner(a, await a.waitFor("acquired"));
			await release(a);
			const refused = await b.waitFor("refused");
			assert.match(String(refused.message), /superseded/);
			assert.deepEqual(await b.waitForExit(), { code: 1, signal: null });
			assert.equal(
				b.events.some((event) => event.type === "acquired"),
				false,
			);
			assert.ok(
				b.events.some(
					(event) =>
						event.type === "sql-return" &&
						event.sql === "BEGIN EXCLUSIVE" &&
						event.transaction === true,
				),
			);
			assert.equal(
				b.events.some(
					(event) =>
						event.type === "sql-start" &&
						String(event.sql).includes("CREATE TABLE"),
				),
				false,
			);
			assert.equal(
				(await readdir(root)).filter((name) => name.includes(".stale-")).length,
				1,
			);
			await assert.rejects(readFile(`${lockPath}.owner`), { code: "ENOENT" });
		});

		test("refuses a live owner before any SQLite acquisition or wait", async () => {
			const owner = actor();
			const before = await assertOwner(owner, await acquire(owner));
			const contender = actor();
			await contender.waitFor("prepared");
			contender.send("acquire");
			const refused = await contender.waitFor("refused");
			assert.match(String(refused.message), /installer is active/);
			assert.deepEqual(await contender.waitForExit(), {
				code: 1,
				signal: null,
			});
			assert.equal(
				contender.events.some((event) => event.type === "sql-start"),
				false,
			);
			assert.equal(await readFile(`${lockPath}.owner`, "utf8"), before);
			await release(owner);
		});

		test("recovers again after SIGKILL of the elected recovery owner", async () => {
			await seedDeadOwner();
			const [a, b] = await preparedPair();
			crossInstallLockPromotions(a, b);
			await assertRefusedWhileHeld(a, b);
			const original = await readFile(`${lockPath}.owner`, "utf8");
			await a.terminate();
			assert.deepEqual(await a.result, { code: null, signal: "SIGKILL" });
			const [c, d] = await preparedPair();
			crossInstallLockPromotions(c, d);
			await assertRefusedWhileHeld(c, d);
			assert.notEqual(await readFile(`${lockPath}.owner`, "utf8"), original);
			await release(c);
		});

		test("a killed contender releases its real SHARED lock without owning metadata", async () => {
			await seedDeadOwner();
			const before = await readFile(`${lockPath}.owner`, "utf8");
			const [a, b] = await preparedPair();
			a.onNative((line) => {
				if (line.includes(" FIRST_RESERVED ")) b.send("acquire");
			});
			a.send("acquire");
			await b.waitForNative(" RESERVED_BUSY ");
			assert.equal(await readFile(`${lockPath}.owner`, "utf8"), before);
			await b.terminate();
			assert.deepEqual(await b.result, { code: null, signal: "SIGKILL" });
			assert.equal(
				b.events.some((event) => event.type === "acquired"),
				false,
			);
			a.permitNative();
			await assertOwner(a, await a.waitFor("acquired"));
			await release(a);
		});
	});
}
