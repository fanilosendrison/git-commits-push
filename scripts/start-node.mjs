import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"];
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");
const repositoryDirectory = path.resolve(skillDirectory, "../..");
const nodeRuntimeDirectory = path.join(
	repositoryDirectory,
	"packages",
	"node-runtime",
);
const require = createRequire(import.meta.url);
const typescriptCliPath = require.resolve("typescript/bin/tsc");

function runBuildStep(args, cwd) {
	const result = spawnSync(process.execPath, args, {
		cwd,
		env: process.env,
		shell: false,
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status === null) {
		throw new Error(
			`Build step terminated by ${result.signal ?? "unknown signal"}`,
		);
	}
	return result.status;
}

const runtimeBuildStatus = runBuildStep(
	[typescriptCliPath, "-p", "tsconfig.build.json"],
	nodeRuntimeDirectory,
);
if (runtimeBuildStatus !== 0) {
	process.exitCode = runtimeBuildStatus;
} else {
	const skillBuildStatus = runBuildStep(
		[path.join(scriptDirectory, "build-node.mjs")],
		skillDirectory,
	);
	if (skillBuildStatus !== 0) {
		process.exitCode = skillBuildStatus;
	} else {
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
		const supervisor = spawn(
			process.execPath,
			[supervisorPath, ...process.argv.slice(2)],
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
		let forwardedSignal = null;
		const signalHandlers = new Map();
		for (const signal of FORWARDED_SIGNALS) {
			const handler = () => {
				forwardedSignal ??= signal;
				signalProcessTree(supervisor, signal);
			};
			signalHandlers.set(signal, handler);
			process.on(signal, handler);
		}
		supervisor.once("error", (error) => {
			spawnError = error;
		});
		const { exitCode, signal } = await new Promise((resolve) => {
			supervisor.once("close", (code, closeSignal) => {
				resolve({ exitCode: code, signal: closeSignal });
			});
		});
		for (const [registeredSignal, handler] of signalHandlers) {
			process.removeListener(registeredSignal, handler);
		}
		if (spawnError) {
			process.stderr.write(
				`Node supervisor failed to start: ${spawnError.message}\n`,
			);
			process.exitCode = 1;
		} else if (forwardedSignal) {
			process.kill(process.pid, forwardedSignal);
		} else if (signal) {
			process.stderr.write(`Node supervisor terminated by ${signal}\n`);
			process.exitCode = 1;
		} else {
			process.exitCode = exitCode ?? 1;
		}
	}
}
