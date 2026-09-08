import { spawn } from "node:child_process";
import path from "node:path";
import {
	signalProcessTree,
	usesIsolatedProcessGroup,
} from "@git-commits-push/node-runtime";

export interface SupervisorPassResult {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly spawnError: Error | null;
}

export interface RunSupervisorPassOptions {
	readonly compiledApplicationDirectory: string;
	readonly passthroughArguments: readonly string[];
	readonly abortSignal?: AbortSignal;
}

function cancellationSignal(
	abortSignal: AbortSignal | undefined,
): NodeJS.Signals {
	return typeof abortSignal?.reason === "string" &&
		abortSignal.reason.startsWith("SIG")
		? (abortSignal.reason as NodeJS.Signals)
		: "SIGTERM";
}

/** Run one compiled supervisor pass under launcher-owned cancellation. */
export async function runSupervisorPass({
	compiledApplicationDirectory,
	passthroughArguments,
	abortSignal,
}: RunSupervisorPassOptions): Promise<SupervisorPassResult> {
	const supervisorPath = path.join(
		compiledApplicationDirectory,
		"src",
		"entrypoints",
		"node-supervisor.js",
	);
	if (abortSignal?.aborted) {
		return {
			exitCode: null,
			signal: cancellationSignal(abortSignal),
			spawnError: null,
		};
	}
	const supervisor = spawn(
		process.execPath,
		[supervisorPath, ...passthroughArguments],
		{
			cwd: compiledApplicationDirectory,
			detached: usesIsolatedProcessGroup,
			env: process.env,
			shell: false,
			stdio: "inherit",
			windowsHide: true,
		},
	);
	const observation: { spawnError: Error | null } = { spawnError: null };
	supervisor.once("error", (error) => {
		observation.spawnError = error;
	});
	const abortHandler = (): void => {
		signalProcessTree(supervisor, cancellationSignal(abortSignal));
	};
	abortSignal?.addEventListener("abort", abortHandler, { once: true });
	if (abortSignal?.aborted) abortHandler();
	const { exitCode, signal } = await new Promise<{
		exitCode: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve) => {
		supervisor.once("close", (code, closeSignal) => {
			resolve({ exitCode: code, signal: closeSignal });
		});
	});
	abortSignal?.removeEventListener("abort", abortHandler);
	if (observation.spawnError) {
		process.stderr.write(
			`Node supervisor failed to start: ${observation.spawnError.message}\n`,
		);
	} else if (signal) {
		process.stderr.write(`Node supervisor terminated by ${signal}\n`);
	}
	return { exitCode, signal, spawnError: observation.spawnError };
}
