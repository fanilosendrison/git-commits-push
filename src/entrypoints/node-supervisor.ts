import {
	type ChildProcess,
	type ChildProcessByStdio,
	spawn,
} from "node:child_process";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import {
	signalProcessTree,
	usesIsolatedProcessGroup,
} from "../../../../packages/node-runtime/src/process-tree.ts";
import { isDirectExecution } from "../utils/direct-execution.ts";

const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const SUPERVISOR_SIGNALS = ["SIGINT", "SIGTERM"] as const;

type SupervisorSignal = (typeof SUPERVISOR_SIGNALS)[number];

export interface PipelineStageCommand {
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string | URL;
	readonly env?: NodeJS.ProcessEnv;
}

export interface SupervisePipelineOptions {
	readonly producer: PipelineStageCommand;
	readonly consumer: PipelineStageCommand;
	readonly stdout?: Writable;
	readonly stderr?: Writable;
	readonly signal?: AbortSignal;
	readonly terminationGraceMs?: number;
}

export interface PipelineStageResult {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly spawnError: Error | null;
}

export interface PipelineResult {
	readonly producer: PipelineStageResult;
	readonly consumer: PipelineStageResult;
	readonly exitCode: number;
	readonly terminationReason: "exit" | "aborted";
}

type ProducerProcess = ChildProcessByStdio<null, Readable, Readable>;
type ConsumerProcess = ChildProcessByStdio<Writable, Readable, Readable>;

function stageSpawnOptions(stage: PipelineStageCommand) {
	return {
		...(stage.cwd === undefined ? {} : { cwd: stage.cwd }),
		detached: usesIsolatedProcessGroup,
		env: stage.env ?? process.env,
		shell: false as const,
		windowsHide: true,
	};
}

function observeStage(child: ChildProcess): Promise<PipelineStageResult> {
	let spawnError: Error | null = null;
	child.once("error", (error) => {
		spawnError = error;
	});
	return new Promise((resolve) => {
		child.once("close", (exitCode, signal) => {
			resolve({ exitCode, signal, spawnError });
		});
	});
}

function isRunning(child: ChildProcess): boolean {
	return child.exitCode === null && child.signalCode === null;
}

function createAbortedResult(): PipelineResult {
	const stageResult: PipelineStageResult = {
		exitCode: null,
		signal: null,
		spawnError: null,
	};
	return {
		consumer: stageResult,
		exitCode: 1,
		producer: stageResult,
		terminationReason: "aborted",
	};
}

function resolvePipelineExitCode(
	producer: PipelineStageResult,
	consumer: PipelineStageResult,
	ioError: Error | null,
): number {
	if (producer.spawnError || consumer.spawnError || ioError) return 1;
	if (producer.signal || consumer.signal) return 1;
	if (consumer.exitCode !== null && consumer.exitCode !== 0) {
		return consumer.exitCode;
	}
	if (producer.exitCode !== null && producer.exitCode !== 0) {
		return producer.exitCode;
	}
	return 0;
}

export async function supervisePipeline(
	options: SupervisePipelineOptions,
): Promise<PipelineResult> {
	if (options.signal?.aborted) return createAbortedResult();

	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	const consumer: ConsumerProcess = spawn(
		options.consumer.command,
		[...(options.consumer.args ?? [])],
		{
			...stageSpawnOptions(options.consumer),
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const producer: ProducerProcess = spawn(
		options.producer.command,
		[...(options.producer.args ?? [])],
		{
			...stageSpawnOptions(options.producer),
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	let terminationStarted = false;
	let forceKillTimer: NodeJS.Timeout | undefined;
	let ioError: Error | null = null;
	const terminateChildren = (): void => {
		if (terminationStarted) return;
		terminationStarted = true;
		for (const child of [producer, consumer]) {
			if (isRunning(child)) signalProcessTree(child, "SIGTERM");
		}
		forceKillTimer = setTimeout(() => {
			for (const child of [producer, consumer]) {
				if (isRunning(child)) signalProcessTree(child, "SIGKILL");
			}
		}, options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
		forceKillTimer.unref();
	};
	const recordIoError = (error: Error): void => {
		if ("code" in error && (error as NodeJS.ErrnoException).code === "EPIPE") {
			return;
		}
		ioError ??= error;
		terminateChildren();
	};

	consumer.stdin.on("error", recordIoError);
	producer.stdout.on("error", recordIoError);
	consumer.stdout.on("error", recordIoError);
	producer.stderr.on("error", recordIoError);
	consumer.stderr.on("error", recordIoError);
	producer.once("error", terminateChildren);
	consumer.once("error", terminateChildren);
	consumer.once("exit", () => {
		if (isRunning(producer) && !producer.stdout.readableEnded) {
			terminateChildren();
		}
	});

	producer.stdout.pipe(consumer.stdin);
	consumer.stdout.pipe(stdout, { end: false });
	producer.stderr.pipe(stderr, { end: false });
	consumer.stderr.pipe(stderr, { end: false });

	const abortHandler = (): void => terminateChildren();
	options.signal?.addEventListener("abort", abortHandler, { once: true });
	if (options.signal?.aborted) abortHandler();

	const [producerResult, consumerResult] = await Promise.all([
		observeStage(producer),
		observeStage(consumer),
	]);
	options.signal?.removeEventListener("abort", abortHandler);
	if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);

	return {
		consumer: consumerResult,
		exitCode: resolvePipelineExitCode(producerResult, consumerResult, ioError),
		producer: producerResult,
		terminationReason: options.signal?.aborted ? "aborted" : "exit",
	};
}

export async function runSignalAwarePipeline(
	options: Omit<SupervisePipelineOptions, "signal">,
): Promise<number> {
	const controller = new AbortController();
	let receivedSignal: SupervisorSignal | null = null;
	const signalHandlers = new Map<SupervisorSignal, () => void>();
	for (const signal of SUPERVISOR_SIGNALS) {
		const handler = (): void => {
			receivedSignal ??= signal;
			controller.abort();
		};
		signalHandlers.set(signal, handler);
		process.on(signal, handler);
	}

	try {
		const result = await supervisePipeline({
			...options,
			signal: controller.signal,
		});
		if (receivedSignal !== null) {
			for (const [signal, handler] of signalHandlers) {
				process.removeListener(signal, handler);
			}
			process.kill(process.pid, receivedSignal);
		}
		return result.exitCode;
	} finally {
		for (const [signal, handler] of signalHandlers) {
			process.removeListener(signal, handler);
		}
	}
}

if (isDirectExecution(import.meta.url)) {
	const compiledSkillDirectory = path.resolve(import.meta.dirname, "../..");
	const entrypointDirectory = path.join(
		compiledSkillDirectory,
		"src",
		"entrypoints",
	);
	const exitCode = await runSignalAwarePipeline({
		consumer: {
			args: [path.join(entrypointDirectory, "turnlock-to-llm-bridge.js")],
			command: process.execPath,
			cwd: compiledSkillDirectory,
			env: process.env,
		},
		producer: {
			args: [
				path.join(entrypointDirectory, "turnlock-orchestrator.js"),
				...process.argv.slice(2),
			],
			command: process.execPath,
			cwd: compiledSkillDirectory,
			env: process.env,
		},
	});
	process.exitCode = exitCode;
}
