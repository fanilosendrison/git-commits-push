import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "../..");
const compiledSupervisorPath = path.join(
	skillDirectory,
	"dist",
	"skills",
	"git-commits-push",
	"src",
	"entrypoints",
	"node-supervisor.js",
);
const stageFixturePath = path.join(
	testDirectory,
	"fixtures",
	"pipeline-stage.mjs",
);
const harnessPath = path.join(
	testDirectory,
	"fixtures",
	"supervisor-harness.mjs",
);
const { runSignalAwarePipeline, supervisePipeline } = await import(
	pathToFileURL(compiledSupervisorPath).href
);

function createCapture() {
	let content = "";
	return {
		stream: new Writable({
			write(chunk, _encoding, callback) {
				content += chunk.toString("utf8");
				callback();
			},
		}),
		text: () => content,
	};
}

function stage(mode, arguments_ = [], environment = {}) {
	return {
		args: [stageFixturePath, mode, ...arguments_],
		command: process.execPath,
		env: { ...process.env, ...environment },
	};
}

async function waitForFileContent(filePath, expectedFragments) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const content = await readFile(filePath, "utf8").catch(() => "");
		if (expectedFragments.every((fragment) => content.includes(fragment))) {
			return content;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for child readiness in ${filePath}`);
}

test("passes shell-free arguments through the producer-consumer topology", async () => {
	const stdout = createCapture();
	const stderr = createCapture();
	const argument = "value with spaces; $(printf unsafe) — é";
	const result = await supervisePipeline({
		consumer: stage("prefix-consumer"),
		producer: stage("argument-producer", [argument]),
		stderr: stderr.stream,
		stdout: stdout.stream,
	});

	assert.equal(result.exitCode, 0);
	assert.equal(stdout.text(), `bridge:${argument}`);
	assert.match(stderr.text(), /producer-stderr/);
	assert.match(stderr.text(), /consumer-stderr/);
	assert.doesNotMatch(stderr.text(), /unsafe\) — é/);
});

test("preserves multi-megabyte pipeline data under consumer backpressure", async () => {
	const stdout = createCapture();
	const byteCount = 4 * 1024 * 1024 + 17;
	const result = await supervisePipeline({
		consumer: stage("digest-consumer", ["1"]),
		producer: stage("byte-producer", [String(byteCount)]),
		stdout: stdout.stream,
	});

	assert.equal(result.exitCode, 0);
	assert.deepEqual(JSON.parse(stdout.text()), {
		byteCount,
		sha256: createHash("sha256")
			.update(Buffer.alloc(byteCount, "x"))
			.digest("hex"),
	});
});

test("fails when either pipeline stage exits non-zero", async () => {
	const producerFailureOutput = createCapture();
	const producerFailureErrors = createCapture();
	const producerFailure = await supervisePipeline({
		consumer: stage("prefix-consumer"),
		producer: stage("exit-producer", ["7"]),
		stderr: producerFailureErrors.stream,
		stdout: producerFailureOutput.stream,
	});
	assert.equal(producerFailure.producer.exitCode, 7);
	assert.equal(producerFailure.exitCode, 7);

	const consumerFailureOutput = createCapture();
	const consumerFailureErrors = createCapture();
	const consumerFailure = await supervisePipeline({
		consumer: stage("exit-consumer", ["9"]),
		producer: stage("argument-producer", ["input"]),
		stderr: consumerFailureErrors.stream,
		stdout: consumerFailureOutput.stream,
	});
	assert.equal(consumerFailure.consumer.exitCode, 9);
	assert.equal(consumerFailure.exitCode, 9);
});

test("fails closed when either stage executable is unavailable", async () => {
	const missingExecutable = path.join(
		tmpdir(),
		`missing-pipeline-stage-${process.pid}-${Date.now()}`,
	);
	const missingProducer = await supervisePipeline({
		consumer: stage("prefix-consumer"),
		producer: { command: missingExecutable },
		stderr: createCapture().stream,
		stdout: createCapture().stream,
	});
	assert.equal(missingProducer.exitCode, 1);
	assert.equal(missingProducer.producer.spawnError?.code, "ENOENT");

	const missingConsumer = await supervisePipeline({
		consumer: { command: missingExecutable },
		producer: stage("byte-producer", [String(16 * 1024 * 1024)]),
		stderr: createCapture().stream,
		stdout: createCapture().stream,
		terminationGraceMs: 1000,
	});
	assert.equal(missingConsumer.exitCode, 1);
	assert.equal(missingConsumer.consumer.spawnError?.code, "ENOENT");
});

test("aborts both isolated child process trees", async () => {
	const signalLogPath = path.join(
		tmpdir(),
		`pipeline-abort-${process.pid}-${Date.now()}.log`,
	);
	await writeFile(signalLogPath, "");
	const controller = new AbortController();
	try {
		const resultPromise = supervisePipeline({
			consumer: stage("signal-consumer", [], {
				PIPELINE_SIGNAL_LOG: signalLogPath,
			}),
			producer: stage("signal-producer", [], {
				PIPELINE_SIGNAL_LOG: signalLogPath,
			}),
			signal: controller.signal,
			terminationGraceMs: 1000,
		});
		await waitForFileContent(signalLogPath, [
			"producer:ready",
			"consumer:ready",
		]);
		controller.abort();
		const result = await resultPromise;
		assert.equal(result.terminationReason, "aborted");
		const signalLog = await readFile(signalLogPath, "utf8");
		assert.match(signalLog, /producer:SIGTERM/);
		assert.match(signalLog, /consumer:SIGTERM/);
	} finally {
		await rm(signalLogPath, { force: true });
	}
});

test("forwards SIGTERM and preserves signal termination", async () => {
	const signalLogPath = path.join(
		tmpdir(),
		`pipeline-parent-signal-${process.pid}-${Date.now()}.log`,
	);
	await writeFile(signalLogPath, "");
	const child = spawn(process.execPath, [harnessPath], {
		env: {
			...process.env,
			COMPILED_PIPELINE_SUPERVISOR: compiledSupervisorPath,
			PIPELINE_SIGNAL_LOG: signalLogPath,
			PIPELINE_STAGE_FIXTURE: stageFixturePath,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const completion = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
	});
	try {
		await waitForFileContent(signalLogPath, [
			"producer:ready",
			"consumer:ready",
		]);
		child.kill("SIGTERM");
		const result = await completion;
		assert.deepEqual(result, { exitCode: null, signal: "SIGTERM" });
		const signalLog = await readFile(signalLogPath, "utf8");
		assert.match(signalLog, /producer:SIGTERM/);
		assert.match(signalLog, /consumer:SIGTERM/);
	} finally {
		await rm(signalLogPath, { force: true });
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGKILL");
	}
});

assert.equal(typeof runSignalAwarePipeline, "function");
