import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {
	controllerFixture,
	delay,
	groupExists,
	processRow,
	waitFor,
} from "./fixtures/controller-lifetime-fixture.mjs";

// Execute the actual private helper, not a duplicated parser or a new public API.
const source = readFileSync(
	new URL("../../src/entrypoints/execution-controller.ts", import.meta.url),
	"utf8",
);
const start = source.indexOf("function listOwnGroupMembers()");
const end = source.indexOf("function signalOwnGroup", start);
assert.ok(start >= 0 && end > start);
const helper = ts.transpileModule(source.slice(start, end), {
	compilerOptions: {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.None,
	},
}).outputText;
const pid = 111,
	inspector = 333;
function inspect(result) {
	const context = vm.createContext({
		process: { pid },
		spawnSync: () => result,
	});
	const value = vm.runInContext(helper + "; listOwnGroupMembers()", context);
	return value === null ? null : Array.from(value);
}
const successful = (stdout) => ({
	status: 0,
	stdout: stdout.trim() ? stdout + "333 111\n" : stdout,
	pid: inspector,
});
const self = "111 111\n";
const negatives = [
	["empty successful stdout", successful("")],
	["whitespace successful stdout", successful(" \t\n")],
	["incomplete line", successful("111\n")],
	["non-numeric line", successful("broken row\n")],
	["partial PID", successful("111 111\n222bad 111\n")],
	["partial PGID", successful("111 111bad\n")],
	["fractional PID", successful("111 111\n222.5 111\n")],
	["negative PID", successful("111 111\n-222 111\n")],
	["signed PID", successful("+111 111\n")],
	["exponent PID", successful("111 111\n2e2 111\n")],
	["unsafe integer", successful("111 111\n9007199254740992 111\n")],
	["extra columns", successful("111 111 extra\n")],
	["missing controller", successful("222 111\n")],
	["wrong controller group", successful("111 112\n")],
	["duplicate controller", successful(self + self)],
	["conflicting descendant", successful(self + "222 111\n222 9\n")],
	["ambiguous duplicated descendant", successful(self + "222 111\n222 111\n")],
	["malformed unrelated row", successful(self + "bad unrelated\n")],
	["empty interior row", successful(self + "\n222 111\n")],
	["invalid inspection identity", { ...successful(self), pid: -1 }],
	["inspection aliases controller", { ...successful(self), pid }],
	[
		"incoherent inspector row",
		{ status: 0, stdout: self + "333 9\n", pid: inspector },
	],
	["missing inspector row", { status: 0, stdout: self, pid: inspector }],
	[
		"unestablished inspector identity",
		{ status: 0, stdout: self + "333 111\n" },
	],
	["leading-zero identity", successful("0111 111\n")],
	["negative group identity", successful(self + "222 -1\n")],
	["unavailable stdout", { status: 0, pid: inspector }],
	["unavailable result", undefined],
	["unavailable exit", { ...successful(self), status: null }],
	["nonzero exit", { ...successful(self), status: 1 }],
	[
		"launch error",
		{ ...successful(self), error: new Error("synthetic launch fault") },
	],
];
for (const [name, response] of negatives)
	test(`F2 | ${name} is UNKNOWN, not quiescence`, () =>
		assert.equal(inspect(response), null));

for (const [name, response, expected] of [
	["controller only", successful("  111 111\n"), [111]],
	["controller with descendant", successful(self + "222 111\n"), [111, 222]],
	["unrelated kernel group zero", successful("2 0\n" + self), [111]],
])
	test(`F2 | valid ${name}`, () =>
		assert.deepEqual(inspect(response), expected));

const supported = process.platform === "darwin" || process.platform === "linux";
for (const observation of [
	"empty",
	"blank",
	"malformed",
	"mixed",
	"missing-controller",
	"wrong-controller-group",
	"unavailable",
])
	test(`F2 | actual controller retains cleanup on ${observation}`, {
		skip: !supported,
	}, async () => {
		const f = await controllerFixture({ mode: "resist", observation });
		try {
			await f.prepare();
			await f.start();
			const child = f.remember("child");
			assert.ok(child);
			const leader = processRow(f.pid);
			assert.ok(leader);
			const began = performance.now();
			f.disconnect();
			await delay(1000);
			assert.equal(processRow(f.pid)?.birth, leader.birth);
			assert.equal(processRow(child.pid)?.birth, child.birth);
			assert.ok(!f.messages.some((message) => message.type === "RESULT"));
			await waitFor(
				() => !groupExists(f.pid),
				"unknown observation lost existing escalation",
			);
			assert.ok(
				performance.now() - began >= 4500 && performance.now() - began < 6500,
			);
			assert.equal(f.exit?.signal, "SIGKILL");
			assert.equal(processRow(child.pid), null);
		} finally {
			await f.cleanup();
		}
	});

test("F2 | connected IPC observes no RESULT on an empty successful table", {
	skip: !supported,
}, async () => {
	const f = await controllerFixture({ mode: "resist", observation: "empty" });
	try {
		await f.prepare();
		await f.start();
		const child = f.remember("child");
		assert.ok(child);
		f.killSupervisor();
		await delay(1000);
		assert.ok(processRow(f.pid));
		assert.ok(!f.messages.some((message) => message.type === "RESULT"));
		await waitFor(
			() => !groupExists(f.pid),
			"empty table canceled cleanup timers",
		);
		assert.equal(f.exit?.signal, "SIGKILL");
		assert.equal(processRow(child.pid), null);
	} finally {
		await f.cleanup();
	}
});

test("F2 | valid injected controller-only observation permits early normal exit", {
	skip: !supported,
}, async () => {
	const f = await controllerFixture({
		mode: "quiet",
		observation: "valid-controller",
	});
	try {
		await f.prepare();
		const began = performance.now();
		await f.start();
		await waitFor(
			() => f.exit !== null && !groupExists(f.pid),
			"valid quiescence did not finish",
		);
		assert.deepEqual(f.exit, { code: 0, signal: null });
		assert.equal(
			f.messages.find((message) => message.type === "RESULT")?.exitCode,
			0,
		);
		assert.ok(performance.now() - began < 4500);
	} finally {
		await f.cleanup();
	}
});
