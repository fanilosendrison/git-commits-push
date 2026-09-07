import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	DEFAULT_MAX_CAPTURE_BYTES,
	DEFAULT_TERMINATION_GRACE_MS,
	type ProcessChunkHandler,
	ProcessExecutionError,
	type ProcessExecutionErrorPhase,
	type ProcessInput,
	type ProcessOutputStream,
	type ProcessRequest,
	type ProcessResult,
	type ProcessTerminationReason,
	type RunProcessOptions,
} from "./process-contract.ts";
import { signalProcessTree, usesIsolatedProcessGroup } from "./process-tree.ts";

type ProcessCompletion =
	| {
			readonly kind: "closed";
			readonly exitCode: number | null;
			readonly signal: NodeJS.Signals | null;
	  }
	| { readonly kind: "spawn-error"; readonly error: Error };

interface IoFailure {
	readonly phase: ProcessExecutionErrorPhase;
	readonly error: unknown;
}

interface CapturedOutput {
	readonly chunks: Buffer[];
	byteLength: number;
}

const closedInput: ProcessInput = { kind: "closed" };

export async function runProcess(
	request: ProcessRequest,
	options: RunProcessOptions = {},
): Promise<ProcessResult> {
	const settings = validateInvocation(request, options);
	const args =
		request.shell === undefined || request.shell === false
			? [...(request.args ?? [])]
			: [];

	if (options.signal?.aborted) {
		return createResult(
			request.command,
			args,
			"",
			"",
			null,
			null,
			"aborted",
			null,
		);
	}

	const child = spawn(request.command, args, {
		cwd: options.cwd,
		detached: usesIsolatedProcessGroup,
		env: options.env,
		shell: request.shell ?? false,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});

	const stdout: CapturedOutput = { chunks: [], byteLength: 0 };
	const stderr: CapturedOutput = { chunks: [], byteLength: 0 };
	let processFinished = false;
	let requestedTermination: ProcessTerminationReason | null = null;
	let limitedStream: ProcessOutputStream | null = null;
	const ioState: { failure: IoFailure | null } = { failure: null };
	let terminationStarted = false;
	let timeoutHandle: NodeJS.Timeout | undefined;
	let forceKillHandle: NodeJS.Timeout | undefined;

	const beginTermination = (): void => {
		if (terminationStarted || processFinished) return;
		terminationStarted = true;
		signalProcessTree(child, "SIGTERM");
		forceKillHandle = setTimeout(() => {
			if (!processFinished) signalProcessTree(child, "SIGKILL");
		}, settings.terminationGraceMs);
		forceKillHandle.unref();
	};

	const requestTermination = (
		reason: ProcessTerminationReason,
		stream: ProcessOutputStream | null = null,
	): void => {
		if (requestedTermination !== null) return;
		if (processFinished && reason !== "output-limit") return;
		requestedTermination = reason;
		limitedStream = stream;
		beginTermination();
	};

	const recordIoFailure = (
		phase: ProcessExecutionErrorPhase,
		error: unknown,
	): void => {
		if (ioState.failure !== null) return;
		ioState.failure = { phase, error };
		beginTermination();
	};

	const completionPromise = new Promise<ProcessCompletion>((resolve) => {
		child.once("error", (error) => {
			processFinished = true;
			resolve({ kind: "spawn-error", error });
		});
		child.once("close", (exitCode, signal) => {
			processFinished = true;
			resolve({ kind: "closed", exitCode, signal });
		});
	});

	const stdoutTask = monitorOutput(
		child.stdout,
		"stdout",
		stdout,
		settings.maxCaptureBytes,
		options.onStdoutChunk,
		requestTermination,
	).catch((error: unknown) => recordIoFailure("stdout", error));
	const stderrTask = monitorOutput(
		child.stderr,
		"stderr",
		stderr,
		settings.maxCaptureBytes,
		options.onStderrChunk,
		requestTermination,
	).catch((error: unknown) => recordIoFailure("stderr", error));
	const stdinTask = writeInput(child.stdin, options.stdin ?? closedInput).catch(
		(error: unknown) => {
			if (!isExpectedInputClosure(error, processFinished, terminationStarted)) {
				recordIoFailure("stdin", error);
			}
		},
	);

	const abortHandler = (): void => requestTermination("aborted");
	if (options.signal !== undefined) {
		options.signal.addEventListener("abort", abortHandler, { once: true });
		if (options.signal.aborted) abortHandler();
	}
	if (settings.timeoutMs !== undefined) {
		timeoutHandle = setTimeout(
			() => requestTermination("timeout"),
			settings.timeoutMs,
		);
		timeoutHandle.unref();
	}

	const completion = await completionPromise;
	await Promise.all([stdinTask, stdoutTask, stderrTask]);

	if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
	if (forceKillHandle !== undefined) clearTimeout(forceKillHandle);
	options.signal?.removeEventListener("abort", abortHandler);

	if (completion.kind === "spawn-error") {
		throw createExecutionError("spawn", request.command, completion.error);
	}
	if (ioState.failure !== null) {
		throw createExecutionError(
			ioState.failure.phase,
			request.command,
			ioState.failure.error,
		);
	}

	const terminationReason =
		requestedTermination ?? (completion.exitCode === null ? "signal" : "exit");

	return createResult(
		request.command,
		args,
		Buffer.concat(stdout.chunks, stdout.byteLength).toString("utf8"),
		Buffer.concat(stderr.chunks, stderr.byteLength).toString("utf8"),
		completion.exitCode,
		completion.signal,
		terminationReason,
		limitedStream,
	);
}

function validateInvocation(
	request: ProcessRequest,
	options: RunProcessOptions,
): {
	readonly maxCaptureBytes: number;
	readonly terminationGraceMs: number;
	readonly timeoutMs: number | undefined;
} {
	if (request.command.length === 0) {
		throw new TypeError("Process command must not be empty");
	}
	if (
		request.shell !== undefined &&
		request.shell !== false &&
		"args" in request &&
		request.args !== undefined
	) {
		throw new TypeError(
			"Shell-mode commands must be provided as one explicit command string",
		);
	}
	if (typeof request.shell === "string" && request.shell.length === 0) {
		throw new TypeError("Shell executable must not be empty");
	}
	const maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
	const terminationGraceMs =
		options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
	validateNonNegativeInteger("maxCaptureBytes", maxCaptureBytes);
	validateNonNegativeInteger("terminationGraceMs", terminationGraceMs);
	if (options.timeoutMs !== undefined) {
		validatePositiveInteger("timeoutMs", options.timeoutMs);
	}
	return { maxCaptureBytes, terminationGraceMs, timeoutMs: options.timeoutMs };
}

function validateNonNegativeInteger(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${name} must be a non-negative safe integer`);
	}
}

function validatePositiveInteger(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${name} must be a positive safe integer`);
	}
}

async function monitorOutput(
	source: Readable,
	streamName: ProcessOutputStream,
	capture: CapturedOutput,
	maxCaptureBytes: number,
	handler: ProcessChunkHandler | undefined,
	requestTermination: (
		reason: ProcessTerminationReason,
		stream: ProcessOutputStream,
	) => void,
): Promise<void> {
	for await (const value of source) {
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		await handler?.(chunk);

		const remainingBytes = maxCaptureBytes - capture.byteLength;
		if (chunk.byteLength <= remainingBytes) {
			capture.chunks.push(chunk);
			capture.byteLength += chunk.byteLength;
			continue;
		}

		if (remainingBytes > 0) {
			capture.chunks.push(chunk.subarray(0, remainingBytes));
			capture.byteLength += remainingBytes;
		}
		requestTermination("output-limit", streamName);
	}
}

async function writeInput(
	target: NodeJS.WritableStream,
	input: ProcessInput,
): Promise<void> {
	if (input.kind === "closed") {
		await pipeline(Readable.from([]), target);
		return;
	}
	if (input.kind === "text") {
		await pipeline(Readable.from([input.value]), target);
		return;
	}
	await pipeline(Readable.from(validateInputChunks(input.value)), target);
}

async function* validateInputChunks(
	input: AsyncIterable<string | Uint8Array>,
): AsyncGenerator<string | Uint8Array> {
	for await (const chunk of input) {
		if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
			throw new TypeError(
				"Streaming stdin chunks must be strings or Uint8Array values",
			);
		}
		yield chunk;
	}
}

function isExpectedInputClosure(
	error: unknown,
	processFinished: boolean,
	terminationStarted: boolean,
): boolean {
	if (!processFinished && !terminationStarted) return false;
	const code = getErrorCode(error);
	return code === "EPIPE" || code === "ERR_STREAM_PREMATURE_CLOSE";
}

function createExecutionError(
	phase: ProcessExecutionErrorPhase,
	command: string,
	cause: unknown,
): ProcessExecutionError {
	const code = getErrorCode(cause);
	const suffix = code === undefined ? "" : ` (${code})`;
	return new ProcessExecutionError(
		`Process ${phase} failed for ${JSON.stringify(command)}${suffix}`,
		{ phase, command, code, cause },
	);
}

function getErrorCode(error: unknown): string | undefined {
	if (!(error instanceof Error) || !("code" in error)) return undefined;
	const code = (error as NodeJS.ErrnoException).code;
	return typeof code === "string" ? code : undefined;
}

function createResult(
	command: string,
	args: readonly string[],
	stdout: string,
	stderr: string,
	exitCode: number | null,
	signal: NodeJS.Signals | null,
	terminationReason: ProcessTerminationReason,
	limitedStream: ProcessOutputStream | null,
): ProcessResult {
	return {
		command,
		args,
		stdout,
		stderr,
		exitCode,
		signal,
		terminationReason,
		limitedStream,
	};
}
