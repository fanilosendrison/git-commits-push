import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { runControlledStep } from "../../src/modules/qualification/controlled-step.ts";
import {
	qualificationHistoricalDirectories,
	runQualification,
} from "../../src/modules/qualification/suite.ts";
import { processGroupExists } from "../../src/modules/reconciliation/execution-boundary-process.ts";

type BoundaryEvent = { type: string; groupId?: number };
function events(file: string): BoundaryEvent[] {
	return existsSync(file)
		? readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as BoundaryEvent)
		: [];
}
async function groupsGone(file: string): Promise<void> {
	const groups = events(file)
		.filter((event) => event.type === "controller_ready")
		.map((event) => event.groupId);
	assert.ok(groups.length > 0, "no actual prepared boundary was observed");
	const deadline = performance.now() + 10_000;
	while (
		groups.some((group) => group !== undefined && processGroupExists(group)) &&
		performance.now() < deadline
	)
		await delay(20);
	for (const group of groups) {
		assert.ok(group);
		assert.equal(processGroupExists(group), false);
	}
}

test("review F1: evidence-write failure terminates the inert boundary and permits natural CLI exit", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "qualification-write-failure-"));
	const output = path.join(root, "run"),
		eventFile = path.join(root, "events.jsonl");
	mkdirSync(path.join(output, "boundary-identity.json"), { recursive: true });
	const driver = path.join(root, "driver.mjs");
	const moduleUrl = pathToFileURL(
		path.resolve(
			import.meta.dirname,
			"../../src/modules/qualification/controlled-step.ts",
		),
	).href;
	writeFileSync(
		driver,
		`import {runControlledStep} from ${JSON.stringify(moduleUrl)};\ntry{await runControlledStep({command:process.execPath,args:['-e','process.exit(0)'],cwd:${JSON.stringify(root)},outputDirectory:${JSON.stringify(output)},signal:new AbortController().signal});throw Error('write unexpectedly succeeded');}catch(error){if(error.code!=='EISDIR')throw error;console.log('EXPECTED_EISDIR');}\n`,
	);
	try {
		const result = spawnSync(process.execPath, [driver], {
			encoding: "utf8",
			timeout: 10_000,
			env: {
				...process.env,
				NODE_ENV: "test",
				GCP_TEST_EXECUTION_EVENTS_PATH: eventFile,
			},
		});
		await groupsGone(eventFile);
		assert.equal(
			result.error,
			undefined,
			"a prepared controller kept the driver alive",
		);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /EXPECTED_EISDIR/u);
		assert.equal(existsSync(path.join(output, "boundary")), false);
	} finally {
		await groupsGone(eventFile);
		rmSync(root, { recursive: true, force: true });
	}
});

test("review F2: separator-only and blank historical lists refuse before qualification", async () => {
	const original = process.env.GCP_QUALIFY_LEGACY_RELEASES;
	try {
		for (const value of ["", path.delimiter, path.delimiter.repeat(3), " "]) {
			process.env.GCP_QUALIFY_LEGACY_RELEASES = value;
			assert.throws(
				() => qualificationHistoricalDirectories(value),
				/non-empty parsed directory list/u,
			);
			await assert.rejects(
				runQualification(),
				/requires explicit historical-release fixture inputs/u,
			);
		}
		assert.deepEqual(
			qualificationHistoricalDirectories(`/first${path.delimiter}/second`),
			["/first", "/second"],
		);
	} finally {
		if (original === undefined) delete process.env.GCP_QUALIFY_LEGACY_RELEASES;
		else process.env.GCP_QUALIFY_LEGACY_RELEASES = original;
	}
});

test("review F3: cancellation while READY is held must terminate without START", async () => {
	const root = mkdtempSync(
		path.join(tmpdir(), "qualification-prepare-cancel-"),
	);
	const eventFile = path.join(root, "events.jsonl"),
		barrier = path.join(root, "ready.release"),
		marker = path.join(root, "executed");
	const keys = [
		"NODE_ENV",
		"GCP_TEST_EXECUTION_EVENTS_PATH",
		"GCP_TEST_EXECUTION_READY_BARRIER",
	] as const;
	const original = new Map(keys.map((key) => [key, process.env[key]]));
	process.env.NODE_ENV = "test";
	process.env.GCP_TEST_EXECUTION_EVENTS_PATH = eventFile;
	process.env.GCP_TEST_EXECUTION_READY_BARRIER = barrier;
	const kill = process.kill;
	// Scheduling-only fault injection gives a mistakenly sent START time to be observed.
	process.kill = ((pid, signal) => {
		if (signal === "SIGTERM")
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
		return kill(pid, signal);
	}) as typeof process.kill;
	const abort = new AbortController();
	const pending = runControlledStep({
		command: process.execPath,
		args: [
			"-e",
			`require('node:fs').writeFileSync(${JSON.stringify(marker)},'unauthorized')`,
		],
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
		while (
			!events(eventFile).some((event) => event.type === "controller_ready") &&
			performance.now() < deadline
		)
			await delay(20);
		assert.ok(
			events(eventFile).some((event) => event.type === "controller_ready"),
		);
		abort.abort();
		writeFileSync(barrier, "release\n");
		const outcome = await settled;
		if ("error" in outcome) throw outcome.error;
		assert.equal(outcome.result.success, false);
		assert.equal(outcome.result.aborted, true);
		assert.equal(outcome.result.groupAbsent, true);
		assert.equal(outcome.result.error, "ABORTED_DURING_PREPARATION");
		assert.equal(
			events(eventFile).some(
				(event) =>
					event.type === "controller_start_received" ||
					event.type === "supervisor_started",
			),
			false,
		);
		assert.equal(existsSync(marker), false);
	} finally {
		abort.abort();
		writeFileSync(barrier, "release\n");
		await settled;
		process.kill = kill;
		for (const key of keys) {
			const value = original.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await groupsGone(eventFile);
		rmSync(root, { recursive: true, force: true });
	}
});
