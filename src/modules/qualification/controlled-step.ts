import { randomBytes } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { processGroupExists } from "../reconciliation/execution-boundary-process.ts";
import { prepareSupervisorPass } from "../reconciliation/supervisor-pass.ts";

const receiptSchema = z
	.object({
		exitCode: z.number().int().nullable(),
		signal: z.string().nullable(),
		spawnError: z.string().nullable(),
		residual: z.array(z.number().int().positive()).nullable(),
	})
	.strict();
export interface ControlledStepRequest {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly outputDirectory: string;
	readonly signal: AbortSignal;
}
export interface ControlledStepResult {
	readonly success: boolean;
	readonly aborted: boolean;
	readonly groupAbsent: boolean;
	readonly controllerExitCode: number | null;
	readonly controllerSignal: NodeJS.Signals | null;
	readonly command: z.infer<typeof receiptSchema> | null;
	readonly error: string | null;
}

/** Contributor-only process containment; reuse the actual maintained controller/host protocol. */
export async function runControlledStep(
	request: ControlledStepRequest,
): Promise<ControlledStepResult> {
	if (request.signal.aborted)
		return {
			success: false,
			aborted: true,
			groupAbsent: true,
			controllerExitCode: null,
			controllerSignal: null,
			command: null,
			error: "ABORTED_BEFORE_START",
		};
	const root = path.resolve(import.meta.dirname, "../../..");
	const output = path.resolve(request.outputDirectory);
	mkdirSync(output, { recursive: true, mode: 0o700 });
	const projection = path.join(output, "boundary");
	const entrypoints = path.join(projection, "src", "entrypoints");
	mkdirSync(entrypoints, { recursive: true, mode: 0o700 });
	// A source-only Node entrypoint projection, never an installed release or new controller.
	symlinkSync(
		path.join(root, "src", "entrypoints", "execution-controller.ts"),
		path.join(entrypoints, "execution-controller.js"),
	);
	symlinkSync(
		path.join(root, "src", "modules", "qualification", "command-worker.ts"),
		path.join(entrypoints, "node-supervisor.js"),
	);
	const receiptFile = path.join(output, "command-result.json");
	const requestFile = path.join(output, "command-request.json");
	writeFileSync(
		requestFile,
		`${JSON.stringify({
			command: request.command,
			args: request.args,
			cwd: request.cwd,
			receipt: receiptFile,
			stdout: path.join(output, "stdout.log"),
			stderr: path.join(output, "stderr.log"),
		})}\n`,
		{ mode: 0o600 },
	);
	const prepared = await prepareSupervisorPass({
		compiledApplicationDirectory: projection,
		passthroughArguments: [requestFile],
		executionToken: randomBytes(16).toString("hex"),
		invocationDirectory: request.cwd,
	});
	let groupAbsent = false;
	try {
		writeFileSync(
			path.join(output, "boundary-identity.json"),
			`${JSON.stringify({
				pid: prepared.pid,
				groupId: prepared.groupId,
				processIdentity: prepared.processIdentity,
			})}\n`,
			{ mode: 0o600 },
		);
		if (request.signal.aborted) {
			await prepared.terminate();
			groupAbsent = !processGroupExists(prepared.groupId);
			return {
				success: false,
				aborted: true,
				groupAbsent,
				controllerExitCode: null,
				controllerSignal: null,
				command: null,
				error: "ABORTED_DURING_PREPARATION",
			};
		}
		const result = await prepared.start(request.signal);
		groupAbsent = !processGroupExists(prepared.groupId);
		let command: ControlledStepResult["command"] = null;
		let error: string | null = null;
		try {
			command = receiptSchema.parse(
				JSON.parse(readFileSync(receiptFile, "utf8")),
			);
		} catch {
			error = "COMMAND_RECEIPT_UNAVAILABLE";
		}
		const success =
			!request.signal.aborted &&
			groupAbsent &&
			result.exitCode === 0 &&
			result.signal === null &&
			result.spawnError === null &&
			command !== null &&
			command.exitCode === 0 &&
			command.signal === null &&
			command.spawnError === null &&
			command.residual !== null &&
			command.residual.length === 0;
		return {
			success,
			aborted: request.signal.aborted,
			groupAbsent,
			controllerExitCode: result.exitCode,
			controllerSignal: result.signal,
			command,
			error,
		};
	} catch (failure) {
		try {
			await prepared.terminate();
			groupAbsent = !processGroupExists(prepared.groupId);
		} catch (cleanupFailure) {
			throw new AggregateError(
				[failure, cleanupFailure],
				"Qualification failed and boundary cleanup remains indeterminate.",
			);
		}
		throw failure;
	} finally {
		prepared.disconnect();
		if (groupAbsent) rmSync(projection, { force: true, recursive: true });
	}
}
