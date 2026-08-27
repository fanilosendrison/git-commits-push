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

interface DeferredSignal {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
}

function createDeferredSignal(): DeferredSignal {
	let resolve = (): void => {
		throw new Error("Deferred signal resolved before initialization");
	};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function waitForSignal(
	signal: Promise<void>,
	description: string,
): Promise<void> {
	const timeoutController = new AbortController();
	try {
		await Promise.race([
			signal,
			delay(1_000, undefined, { signal: timeoutController.signal }).then(() => {
				throw new Error(`Timed out waiting for ${description}`);
			}),
		]);
	} finally {
		timeoutController.abort();
	}
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

test("passes shell-free arguments without interpolation", async () => {
	const args = ["hello world", "$(printf injected)", "semi;colon", "étoile"];
	const result = await runFixture("echo-args", args);

	assert.equal(result.terminationReason, "exit");
	assert.equal(result.exitCode, 0);
	assert.deepEqual(JSON.parse(result.stdout), args);
});

test("runs a command string only when shell mode is explicit", async () => {
	const result = await runProcess({
		command: "printf shell-mode",
		shell: true,
	});

	assert.equal(result.terminationReason, "exit");
	assert.equal(result.stdout, "shell-mode");
	assert.equal(result.stderr, "");
});

test("rejects arguments in explicit shell mode instead of silently dropping them", async () => {
	const invalidRequest = {
		command: "printf unsafe",
		args: ["ignored"],
		shell: true,
	} as unknown as Parameters<typeof runProcess>[0];

	await assert.rejects(runProcess(invalidRequest), {
		name: "TypeError",
		message:
			"Shell-mode commands must be provided as one explicit command string",
	});
});

test("passes cwd and an explicit environment", async () => {
	const cwd = await makeTemporaryDirectory("node-runtime-context-");
	const result = await runFixture("context", [], {
		cwd,
		env: { ...process.env, NODE_RUNTIME_TEST_VALUE: "isolated" },
	});

	assert.deepEqual(JSON.parse(result.stdout), {
		cwd: await realpath(cwd),
		value: "isolated",
	});
});

test("closes stdin by default", async () => {
	const result = await runFixture("stdin");

	assert.equal(result.stdout, "");
	assert.equal(result.terminationReason, "exit");
});

test("writes text stdin and closes the stream", async () => {
	const result = await runFixture("stdin", [], {
		stdin: { kind: "text", value: "line one\nline two\n" },
	});

	assert.equal(result.stdout, "line one\nline two\n");
});

test("writes streaming stdin with backpressure", async () => {
	async function* input() {
		yield "first";
		yield new Uint8Array(128 * 1024).fill(97);
		yield "last";
	}

	const result = await runFixture("stdin-size", [], {
		stdin: { kind: "stream", value: input() },
	});

	assert.equal(result.stdout, String(5 + 128 * 1024 + 4));
});

test("captures stdout and stderr separately without inheriting either stream", async () => {
	const result = await runFixture("split-output");

	assert.equal(result.stdout, "captured stdout");
	assert.equal(result.stderr, "captured stderr");
});

test("returns non-zero exit codes without throwing", async () => {
	const result = await runFixture("exit", ["23"]);

	assert.equal(result.terminationReason, "exit");
	assert.equal(result.exitCode, 23);
	assert.equal(result.signal, null);
});

test("reports signal termination", {
	skip: process.platform === "win32",
}, async () => {
	const result = await runFixture("signal");

	assert.equal(result.terminationReason, "signal");
	assert.equal(result.exitCode, null);
	assert.equal(result.signal, "SIGTERM");
});

test("rejects a missing executable with a classified spawn error", async () => {
	await assert.rejects(
		runProcess({
			command: "/definitely/missing/node-runtime-command",
			args: [],
		}),
		(error: unknown) => {
			assert.ok(error instanceof ProcessExecutionError);
			assert.equal(error.phase, "spawn");
			assert.equal(error.code, "ENOENT");
			assert.equal(error.command, "/definitely/missing/node-runtime-command");
			return true;
		},
	);
});

test("does not spawn when the AbortSignal is already aborted", async () => {
	const controller = new AbortController();
	controller.abort();

	const result = await runProcess(
		{ command: "/definitely/missing/node-runtime-command", args: [] },
		{ signal: controller.signal },
	);

	assert.equal(result.terminationReason, "aborted");
	assert.equal(result.exitCode, null);
	assert.equal(result.stdout, "");
});

test("preserves a normal exit when abort arrives after process completion", async () => {
	const controller = new AbortController();
	const outputObserved = createDeferredSignal();
	const releaseOutputHandler = createDeferredSignal();
	let pidOutput = "";
	const execution = runFixture("emit-pid-and-exit", [], {
		signal: controller.signal,
		onStdoutChunk: async (chunk) => {
			pidOutput += Buffer.from(chunk).toString("utf8");
			outputObserved.resolve();
			await releaseOutputHandler.promise;
		},
	});

	await waitForSignal(outputObserved.promise, "the child PID");
	const childPid = Number(pidOutput.trim());
	try {
		assert.ok(Number.isSafeInteger(childPid));
		assert.ok(childPid > 0);
		await waitForProcessToDisappear(childPid);
		controller.abort();
	} finally {
		releaseOutputHandler.resolve();
	}
	const result = await execution;

	assert.equal(result.terminationReason, "exit");
	assert.equal(result.exitCode, 0);
	assert.equal(result.signal, null);
});

test("reports a delayed output error even after process completion", async () => {
	const outputObserved = createDeferredSignal();
	const rejectOutputHandler = createDeferredSignal();
	let pidOutput = "";
	const execution = runFixture("emit-pid-and-exit", [], {
		onStdoutChunk: async (chunk) => {
			pidOutput += Buffer.from(chunk).toString("utf8");
			outputObserved.resolve();
			await rejectOutputHandler.promise;
			throw new Error("delayed sink failure");
		},
	});

	await waitForSignal(outputObserved.promise, "the child PID");
	const childPid = Number(pidOutput.trim());
	assert.ok(Number.isSafeInteger(childPid));
	assert.ok(childPid > 0);
	await waitForProcessToDisappear(childPid);
	rejectOutputHandler.resolve();

	await assert.rejects(execution, (error: unknown) => {
		assert.ok(error instanceof ProcessExecutionError);
		assert.equal(error.phase, "stdout");
		assert.match(String(error.cause), /delayed sink failure/);
		return true;
	});
});

test("reports an output error when abort is requested first", async () => {
	const controller = new AbortController();
	await assert.rejects(
		runFixture("ignore-sigterm", [], {
			signal: controller.signal,
			terminationGraceMs: 50,
			onStdoutChunk: () => {
				controller.abort();
				throw new Error("abort race sink failure");
			},
		}),
		(error: unknown) => {
			assert.ok(error instanceof ProcessExecutionError);
			assert.equal(error.phase, "stdout");
			assert.match(String(error.cause), /abort race sink failure/);
			return true;
		},
	);
});

test("reports a spawn error when abort races a missing executable", async () => {
	const controller = new AbortController();
	const execution = runProcess(
		{
			command: "/definitely/missing/node-runtime-race-command",
			args: [],
		},
		{ signal: controller.signal },
	);
	controller.abort();

	await assert.rejects(execution, (error: unknown) => {
		assert.ok(error instanceof ProcessExecutionError);
		assert.equal(error.phase, "spawn");
		assert.equal(error.code, "ENOENT");
		return true;
	});
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
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
