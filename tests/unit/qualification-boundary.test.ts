import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runControlledStep } from "../../src/modules/qualification/controlled-step.ts";
import {
	QUALIFICATION_COMMANDS,
	QUALIFICATION_TIMEOUT_MS,
	runQualification,
} from "../../src/modules/qualification/suite.ts";

function fixtureProgram(pidfile: string, keepParent: boolean): string {
	const child = `require('node:fs').writeFileSync(${JSON.stringify(pidfile)},String(process.pid));process.send('ready');setInterval(()=>{},1000)`;
	return `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','ignore','ignore','ipc']});c.once('message',()=>{${keepParent ? "setInterval(()=>{},1000)" : "process.exit(0)"}})`;
}

test("qualification has the exact seven-command inventory and unchanged three-hour bound", () => {
	assert.deepEqual(QUALIFICATION_COMMANDS, [
		"typecheck",
		"typecheck:node",
		"typecheck:node:stats",
		"lint",
		"test",
		"test:node:build",
		"test:node:stats",
	]);
	assert.equal(QUALIFICATION_TIMEOUT_MS, 10_800_000);
});

test("full qualification refuses absent optional-history inputs rather than counting a skip as PASS", async () => {
	const previous = process.env.GCP_QUALIFY_LEGACY_RELEASES;
	delete process.env.GCP_QUALIFY_LEGACY_RELEASES;
	try {
		await assert.rejects(
			runQualification(),
			/requires explicit historical-release fixture inputs/u,
		);
	} finally {
		if (previous === undefined) delete process.env.GCP_QUALIFY_LEGACY_RELEASES;
		else process.env.GCP_QUALIFY_LEGACY_RELEASES = previous;
	}
});

test("nominal qualification requires actual child success, captured bytes and group absence", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "qualification-normal-"));
	try {
		const result = await runControlledStep({
			command: process.execPath,
			args: [
				"-e",
				"process.stdout.write('exact stdout\\n');process.stderr.write('exact stderr\\n')",
			],
			cwd: root,
			outputDirectory: path.join(root, "run"),
			signal: new AbortController().signal,
		});
		assert.equal(result.success, true);
		assert.equal(result.groupAbsent, true);
		assert.equal(result.command?.exitCode, 0);
		assert.deepEqual(result.command?.residual, []);
		assert.equal(
			readFileSync(path.join(root, "run/stdout.log"), "utf8"),
			"exact stdout\n",
		);
		assert.equal(
			readFileSync(path.join(root, "run/stderr.log"), "utf8"),
			"exact stderr\n",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a zero-exit root leaving an active descendant cannot qualify", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "qualification-residual-"));
	try {
		const pidfile = path.join(root, "child.pid");
		const result = await runControlledStep({
			command: process.execPath,
			args: ["-e", fixtureProgram(pidfile, false)],
			cwd: root,
			outputDirectory: path.join(root, "run"),
			signal: new AbortController().signal,
		});
		assert.equal(result.success, false);
		assert.equal(result.groupAbsent, true);
		assert.equal(result.command?.exitCode, 0);
		assert.ok(
			result.command?.residual?.includes(Number(readFileSync(pidfile, "utf8"))),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("cancellation kills the whole owned tree and never returns PASS", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "qualification-cancel-"));
	const abort = new AbortController();
	const pidfile = path.join(root, "child.pid");
	const pending = runControlledStep({
		command: process.execPath,
		args: ["-e", fixtureProgram(pidfile, true)],
		cwd: root,
		outputDirectory: path.join(root, "run"),
		signal: abort.signal,
	});
	const settled = pending.then(
		(result) => ({ result }),
		(error) => ({ error }),
	);
	try {
		const deadline = performance.now() + 10_000;
		while (!existsSync(pidfile) && performance.now() < deadline)
			await delay(20);
		assert.ok(existsSync(pidfile), "owned grandchild never reached readiness");
		abort.abort();
		const outcome = await settled;
		if ("error" in outcome) throw outcome.error;
		assert.equal(outcome.result.success, false);
		assert.equal(outcome.result.aborted, true);
		assert.equal(outcome.result.groupAbsent, true);
	} finally {
		abort.abort();
		await settled;
		rmSync(root, { recursive: true, force: true });
	}
});
