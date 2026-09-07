import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ProcessExecutionError, runProcess } from "../src/index.ts";

const fixturePath = fileURLToPath(
	new URL("./fixtures/process-fixture.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

function runFixture(
	mode: string,
	args: readonly string[] = [],
	options: Parameters<typeof runProcess>[1] = {},
) {
	return runProcess(
		{ command: process.execPath, args: [fixturePath, mode, ...args] },
		options,
	);
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

async function waitForProcessToDisappear(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		await delay(50);
	}
	assert.fail(`Descendant process ${pid} remained alive`);
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

test("terminates a process when its timeout expires", async () => {
	const startedAt = Date.now();
	const result = await runFixture("wait", [], {
		timeoutMs: 50,
		terminationGraceMs: 100,
	});

	assert.equal(result.terminationReason, "timeout");
	assert.ok(Date.now() - startedAt < 2_000);
});

test("escalates to SIGKILL after the termination grace period", {
	skip: process.platform === "win32",
}, async () => {
	const controller = new AbortController();
	const result = await runFixture("ignore-sigterm", [], {
		signal: controller.signal,
		timeoutMs: 5_000,
		terminationGraceMs: 50,
		onStdoutChunk: () => controller.abort(),
	});

	assert.equal(result.terminationReason, "aborted");
	assert.equal(result.signal, "SIGKILL");
});

test("terminates descendants in the isolated process group", {
	skip: process.platform === "win32",
}, async () => {
	const controller = new AbortController();
	let pidOutput = "";
	const result = await runFixture("spawn-descendant", [], {
		signal: controller.signal,
		timeoutMs: 5_000,
		terminationGraceMs: 100,
		onStdoutChunk: (chunk) => {
			pidOutput += Buffer.from(chunk).toString("utf8");
			if (pidOutput.includes("\n")) controller.abort();
		},
	});
	const descendantPid = Number(result.stdout.trim());

	assert.equal(result.terminationReason, "aborted");
	assert.ok(Number.isSafeInteger(descendantPid));
	assert.ok(descendantPid > 0);
	await waitForProcessToDisappear(descendantPid);
});

test("aborts a running process and removes its AbortSignal listener", async () => {
	const controller = new AbortController();
	const listenerCountBefore = getEventListeners(
		controller.signal,
		"abort",
	).length;
	const execution = runFixture("wait", [], {
		signal: controller.signal,
		terminationGraceMs: 100,
	});

	await delay(40);
	controller.abort();
	const result = await execution;

	assert.equal(result.terminationReason, "aborted");
	assert.equal(
		getEventListeners(controller.signal, "abort").length,
		listenerCountBefore,
	);
});

test("removes abort listeners and long timeout timers after normal completion", async () => {
	const controller = new AbortController();
	const listenerCountBefore = getEventListeners(
		controller.signal,
		"abort",
	).length;

	const result = await runFixture("exit", ["0"], {
		signal: controller.signal,
		timeoutMs: 60_000,
	});

	assert.equal(result.terminationReason, "exit");
	assert.equal(
		getEventListeners(controller.signal, "abort").length,
		listenerCountBefore,
	);
});

test("terminates and bounds captured output at the configured byte limit", async () => {
	const result = await runFixture("emit", ["4096"], {
		maxCaptureBytes: 64,
		terminationGraceMs: 100,
	});

	assert.equal(result.terminationReason, "output-limit");
	assert.equal(result.limitedStream, "stdout");
	assert.equal(Buffer.byteLength(result.stdout), 64);
});

test("reports an output limit detected after the child has already closed", async () => {
	const result = await runFixture("emit", ["4096"], {
		maxCaptureBytes: 64,
		onStdoutChunk: async () => {
			await delay(200);
		},
	});

	assert.equal(result.terminationReason, "output-limit");
	assert.equal(result.limitedStream, "stdout");
	assert.equal(Buffer.byteLength(result.stdout), 64);
});

test("awaits output handlers sequentially to preserve backpressure", async () => {
	let activeHandlers = 0;
	let maximumActiveHandlers = 0;
	let observedOutput = "";
	const result = await runFixture("emit-chunks", ["12"], {
		onStdoutChunk: async (chunk) => {
			activeHandlers += 1;
			maximumActiveHandlers = Math.max(maximumActiveHandlers, activeHandlers);
			await delay(10);
			observedOutput += Buffer.from(chunk).toString("utf8");
			activeHandlers -= 1;
		},
	});

	assert.equal(result.terminationReason, "exit");
	assert.equal(maximumActiveHandlers, 1);
	assert.equal(observedOutput, result.stdout);
});

test("classifies output-handler failures and terminates the child", async () => {
	await assert.rejects(
		runFixture("emit-chunks", ["12"], {
			terminationGraceMs: 100,
			onStdoutChunk: () => {
				throw new Error("sink unavailable");
			},
		}),
		(error: unknown) => {
			assert.ok(error instanceof ProcessExecutionError);
			assert.equal(error.phase, "stdout");
			assert.match(String(error.cause), /sink unavailable/);
			return true;
		},
	);
});

test("preserves cwd and script paths containing spaces and Unicode", async () => {
	const cwd = await makeTemporaryDirectory("node runtime é-");
	const copiedFixture = join(cwd, "fixture path é.mjs");
	await cp(fixturePath, copiedFixture);

	const result = await runProcess(
		{
			command: process.execPath,
			args: [copiedFixture, "context"],
		},
		{ cwd, env: process.env },
	);

	const context = JSON.parse(result.stdout) as {
		cwd: string;
		value: string | null;
	};
	assert.equal(
		context.cwd.normalize("NFC"),
		(await realpath(cwd)).normalize("NFC"),
	);
	assert.equal(context.value, null);
});
