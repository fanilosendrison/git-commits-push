import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

function cancellationSignal(abortSignal) {
	return typeof abortSignal?.reason === "string" &&
		abortSignal.reason.startsWith("SIG")
		? abortSignal.reason
		: "SIGTERM";
}

/** Run one compiled supervisor pass under launcher-owned cancellation. */
export async function runSupervisorPass({
	nodeRuntimeDirectory,
	skillDirectory,
	passthroughArguments,
	abortSignal,
}) {
	const compiledSkillDirectory = path.join(
		skillDirectory,
		"dist",
		"skills",
		"git-commits-push",
	);
	const supervisorPath = path.join(
		compiledSkillDirectory,
		"src",
		"entrypoints",
		"node-supervisor.js",
	);
	const { signalProcessTree, usesIsolatedProcessGroup } = await import(
		pathToFileURL(path.join(nodeRuntimeDirectory, "dist", "process-tree.js"))
			.href
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
			cwd: compiledSkillDirectory,
			detached: usesIsolatedProcessGroup,
			env: process.env,
			shell: false,
			stdio: "inherit",
			windowsHide: true,
		},
	);
	let spawnError = null;
	supervisor.once("error", (error) => {
		spawnError = error;
	});
	const abortHandler = () => {
		signalProcessTree(supervisor, cancellationSignal(abortSignal));
	};
	abortSignal?.addEventListener("abort", abortHandler, { once: true });
	if (abortSignal?.aborted) abortHandler();
	const { exitCode, signal } = await new Promise((resolve) => {
		supervisor.once("close", (code, closeSignal) => {
			resolve({ exitCode: code, signal: closeSignal });
		});
	});
	abortSignal?.removeEventListener("abort", abortHandler);
	if (spawnError) {
		process.stderr.write(
			`Node supervisor failed to start: ${spawnError.message}\n`,
		);
	} else if (signal) {
		process.stderr.write(`Node supervisor terminated by ${signal}\n`);
	}
	return { exitCode, signal, spawnError };
}
