import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ProcessLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
}

export function isCompiledJavaScriptModule(moduleUrl: string): boolean {
	const extension = path.extname(fileURLToPath(moduleUrl));
	return extension === ".js" || extension === ".mjs";
}

function serializeShellArgument(value: string): string {
	return JSON.stringify(value);
}

export function buildResumeLaunch(
	runId: string,
	orchestratorModuleUrl: string,
	executablePath: string = process.execPath,
): ProcessLaunch {
	const orchestratorPath = fileURLToPath(orchestratorModuleUrl);
	const compiledSkillDirectory = path.resolve(
		path.dirname(orchestratorPath),
		"../..",
	);
	return {
		args: [orchestratorPath, "--run-id", runId, "--resume"],
		command: executablePath,
		cwd: compiledSkillDirectory,
	};
}

export function buildResumeCommand(
	runId: string,
	orchestratorModuleUrl: string,
	executablePath: string = process.execPath,
): string {
	if (!isCompiledJavaScriptModule(orchestratorModuleUrl)) {
		return `bun run src/entrypoints/turnlock-orchestrator.ts --run-id ${runId} --resume`;
	}
	const launch = buildResumeLaunch(
		runId,
		orchestratorModuleUrl,
		executablePath,
	);
	return [launch.command, ...launch.args].map(serializeShellArgument).join(" ");
}

export function buildQueuedOrderLaunch(
	lockManagerModuleUrl: string,
	executablePath: string = process.execPath,
): ProcessLaunch {
	const lockManagerPath = fileURLToPath(lockManagerModuleUrl);
	const skillDirectory = path.resolve(path.dirname(lockManagerPath), "../..");
	if (!isCompiledJavaScriptModule(lockManagerModuleUrl)) {
		return {
			args: ["run", "start"],
			command: "bun",
			cwd: skillDirectory,
		};
	}
	return {
		args: [
			path.join(skillDirectory, "src", "entrypoints", "node-supervisor.js"),
		],
		command: executablePath,
		cwd: skillDirectory,
	};
}
