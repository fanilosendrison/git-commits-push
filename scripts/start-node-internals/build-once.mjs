import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const typescriptCliPath = require.resolve("typescript/bin/tsc");
const BUILD_TERMINATION_GRACE_MS = 5_000;

function cancellationSignal(abortSignal) {
	return typeof abortSignal?.reason === "string" &&
		abortSignal.reason.startsWith("SIG")
		? abortSignal.reason
		: "SIGTERM";
}

function signalBuildTree(child, signal) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	try {
		if (process.platform !== "win32" && child.pid !== undefined) {
			process.kill(-child.pid, signal);
		} else {
			child.kill(signal);
		}
	} catch (error) {
		if (error?.code !== "ESRCH") throw error;
	}
}

async function runBuildStep(args, cwd, abortSignal) {
	if (abortSignal?.aborted) {
		return { exitCode: null, signal: cancellationSignal(abortSignal) };
	}
	const child = spawn(process.execPath, args, {
		cwd,
		detached: process.platform !== "win32",
		env: process.env,
		shell: false,
		stdio: "inherit",
	});
	let spawnError = null;
	child.once("error", (error) => {
		spawnError = error;
	});
	let escalationTimer = null;
	const abortHandler = () => {
		const signal = cancellationSignal(abortSignal);
		signalBuildTree(child, signal);
		if (signal !== "SIGKILL" && escalationTimer === null) {
			escalationTimer = setTimeout(() => {
				signalBuildTree(child, "SIGKILL");
			}, BUILD_TERMINATION_GRACE_MS);
		}
	};
	abortSignal?.addEventListener("abort", abortHandler, { once: true });
	if (abortSignal?.aborted) abortHandler();
	const result = await new Promise((resolve) => {
		child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
	});
	abortSignal?.removeEventListener("abort", abortHandler);
	if (escalationTimer !== null) clearTimeout(escalationTimer);
	if (spawnError) throw spawnError;
	return result;
}

/** Build private workspace packages and application artifacts for one owner. */
export async function buildOnce({
	packageDirectories,
	scriptDirectory,
	skillDirectory,
	abortSignal,
}) {
	for (const packageDirectory of packageDirectories) {
		const packageBuild = await runBuildStep(
			[typescriptCliPath, "-p", "tsconfig.build.json"],
			packageDirectory,
			abortSignal,
		);
		if (packageBuild.exitCode !== 0) return packageBuild;
	}
	return runBuildStep(
		[path.join(scriptDirectory, "build-node.mjs")],
		skillDirectory,
		abortSignal,
	);
}
