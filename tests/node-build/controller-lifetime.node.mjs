import assert from "node:assert/strict";
import { test } from "node:test";
import {
	controllerFixture,
	delay,
	groupExists,
	processRow,
	waitFor,
} from "./fixtures/controller-lifetime-fixture.mjs";

const supported = process.platform === "darwin" || process.platform === "linux";

for (const scenario of [
	{
		name: "disconnected IPC retains cleanup",
		disconnect: true,
		mode: "resist",
	},
	{
		name: "connected IPC preserves escalation",
		disconnect: false,
		mode: "resist",
	},
	{ name: "owner SIGKILL retains cleanup", owner: true, mode: "resist" },
	{
		name: "child and grandchild terminate",
		disconnect: true,
		mode: "grandchild",
	},
]) {
	test(`CL-01 | ${scenario.name}`, { skip: !supported }, async () => {
		const f = await controllerFixture(scenario);
		try {
			await f.prepare();
			await f.start();
			const child = f.remember("child");
			assert.ok(child);
			const grandchild =
				scenario.mode === "grandchild" ? f.remember("grandchild") : null;
			const ready = f.messages.find((m) => m.type === "READY");
			assert.equal(ready.groupId, f.pid);
			const before = processRow(f.pid);
			assert.ok(before);
			const started = performance.now();
			if (scenario.owner) f.killOwner();
			else {
				f.killSupervisor();
				if (scenario.disconnect) f.disconnect();
			}
			await delay(1000);
			const retained = processRow(f.pid);
			assert.ok(
				retained,
				"controller exited before resistant descendants were cleaned",
			);
			assert.equal(retained.birth, before.birth);
			assert.equal(processRow(child.pid)?.birth, child.birth);
			assert.ok(
				!f.messages.some((m) => m.type === "RESULT"),
				"no false quiescence RESULT",
			);
			await waitFor(
				() => !groupExists(f.pid),
				"existing escalation did not remove the actual group",
			);
			const elapsed = performance.now() - started;
			assert.ok(
				elapsed >= 4500 && elapsed < 6500,
				`expected existing 5s escalation, observed ${elapsed}ms`,
			);
			assert.equal(processRow(f.pid), null);
			assert.equal(processRow(child.pid), null);
			if (grandchild) assert.equal(processRow(grandchild.pid), null);
			process.stdout.write(
				`CL01_ABSENCE=${JSON.stringify({ scenario: scenario.name, controller: before, child, grandchild, elapsed })}\n`,
			);
		} finally {
			await f.cleanup();
		}
	});
}

test("CL-01 | positive early quiescence returns normally before escalation", {
	skip: !supported,
}, async () => {
	const f = await controllerFixture({ mode: "quiet" });
	try {
		await f.prepare();
		const start = performance.now();
		await f.start();
		await waitFor(
			() => f.exit !== null && !groupExists(f.pid),
			"quiet controller did not finish",
		);
		assert.deepEqual(f.exit, { code: 0, signal: null });
		assert.ok(performance.now() - start < 4500);
		assert.equal(f.messages.find((m) => m.type === "RESULT")?.exitCode, 0);
	} finally {
		await f.cleanup();
	}
});

test("CL-01 | disconnect before START never starts a supervisor", {
	skip: !supported,
}, async () => {
	const f = await controllerFixture();
	try {
		await f.prepare();
		f.disconnect();
		await waitFor(
			() => f.exit !== null && !groupExists(f.pid),
			"inert controller did not finish",
		);
		assert.deepEqual(f.exit, { code: 0, signal: null });
		assert.ok(
			!f.messages.some((m) => m.type === "STARTED" || m.type === "RESULT"),
		);
		assert.equal(f.remember("child"), null);
	} finally {
		await f.cleanup();
	}
});

test("CL-01 | unknown group observation never establishes quiescence", {
	skip: !supported,
}, async () => {
	const f = await controllerFixture({ mode: "quiet", unknown: true });
	try {
		await f.prepare();
		await f.start();
		f.disconnect();
		await delay(1000);
		assert.ok(
			processRow(f.pid),
			"unknown observation must retain cleanup authority",
		);
		assert.ok(!f.messages.some((m) => m.type === "RESULT"));
		await waitFor(
			() => !groupExists(f.pid),
			"unknown observation path failed escalation",
		);
		assert.equal(f.exit?.signal, "SIGKILL");
	} finally {
		await f.cleanup();
	}
});

test("CL-01 | actual zombie in owned group is not false absence", {
	skip: !supported,
}, async () => {
	const f = await controllerFixture({ mode: "zombie" });
	try {
		await f.prepare();
		await f.start();
		await waitFor(
			() => f.remember("zombie")?.state.startsWith("Z"),
			"fixture did not establish a real zombie",
		);
		const zombie = f.remember("zombie");
		assert.ok(zombie);
		assert.equal(zombie.pgid, f.pid);
		f.disconnect();
		await delay(1000);
		assert.ok(processRow(f.pid));
		assert.equal(processRow(zombie.pid)?.birth, zombie.birth);
		assert.ok(processRow(zombie.pid)?.state.startsWith("Z"));
		assert.ok(!f.messages.some((m) => m.type === "RESULT"));
		await waitFor(
			() => !groupExists(f.pid),
			"group containing zombie did not terminate",
		);
		assert.equal(processRow(zombie.pid), null);
		process.stdout.write(`CL01_ZOMBIE=${JSON.stringify(zombie)}\n`);
	} finally {
		await f.cleanup();
	}
});
