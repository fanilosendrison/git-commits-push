export const DEFAULT_MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_TERMINATION_GRACE_MS = 5_000;

export type ProcessOutputStream = "stdout" | "stderr";
export type ProcessTerminationReason =
	| "exit"
	| "signal"
	| "timeout"
	| "aborted"
	| "output-limit";
export type ProcessExecutionErrorPhase =
	| "spawn"
	| "stdin"
	| ProcessOutputStream;

export type ProcessInput =
	| { readonly kind: "closed" }
	| { readonly kind: "text"; readonly value: string }
	| {
			readonly kind: "stream";
			readonly value: AsyncIterable<string | Uint8Array>;
	  };

export type ProcessChunkHandler = (chunk: Uint8Array) => void | Promise<void>;

export type ProcessRequest =
	| {
			readonly command: string;
			readonly args?: readonly string[];
			readonly shell?: false;
	  }
	| {
			readonly command: string;
			readonly args?: never;
			readonly shell: true | string;
	  };

export interface RunProcessOptions {
	readonly cwd?: string | URL;
	readonly env?: NodeJS.ProcessEnv;
	readonly stdin?: ProcessInput;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly terminationGraceMs?: number;
	readonly maxCaptureBytes?: number;
	readonly onStdoutChunk?: ProcessChunkHandler;
	readonly onStderrChunk?: ProcessChunkHandler;
}

export interface ProcessResult {
	readonly command: string;
	readonly args: readonly string[];
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly terminationReason: ProcessTerminationReason;
	readonly limitedStream: ProcessOutputStream | null;
}

export class ProcessExecutionError extends Error {
	readonly phase: ProcessExecutionErrorPhase;
	readonly command: string;
	readonly code: string | undefined;

	constructor(
		message: string,
		options: {
			readonly phase: ProcessExecutionErrorPhase;
			readonly command: string;
			readonly code?: string;
			readonly cause: unknown;
		},
	) {
		super(message, { cause: options.cause });
		this.name = "ProcessExecutionError";
		this.phase = options.phase;
		this.command = options.command;
		this.code = options.code;
	}
}
