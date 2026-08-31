import { pathToFileURL } from "node:url";

const supervisorPath = process.env.COMPILED_PIPELINE_SUPERVISOR;
const stagePath = process.env.PIPELINE_STAGE_FIXTURE;
if (!supervisorPath || !stagePath) {
	throw new Error("Compiled supervisor and stage fixture paths are required");
}

const { runSignalAwarePipeline } = await import(
	pathToFileURL(supervisorPath).href
);
const exitCode = await runSignalAwarePipeline({
	consumer: {
		args: [stagePath, "signal-consumer"],
		command: process.execPath,
	},
	producer: {
		args: [stagePath, "signal-producer"],
		command: process.execPath,
	},
});
process.exitCode = exitCode;
