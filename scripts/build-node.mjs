import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyAssets, runProcess } from "@dotagents/node-runtime";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");
const outputDirectory = path.join(skillDirectory, "dist");
const require = createRequire(import.meta.url);
const typescriptCliPath = require.resolve("typescript/bin/tsc");

await rm(outputDirectory, { force: true, recursive: true });

const compileResult = await runProcess(
	{
		command: process.execPath,
		args: [typescriptCliPath, "-p", "tsconfig.build.json"],
	},
	{
		cwd: skillDirectory,
		env: process.env,
		timeoutMs: 120_000,
	},
);
if (compileResult.exitCode !== 0) {
	process.stderr.write(compileResult.stdout);
	process.stderr.write(compileResult.stderr);
	throw new Error(
		`TypeScript compilation failed with exit code ${String(compileResult.exitCode)}`,
	);
}

await copyAssets({
	assets: [
		{
			sourcePath: "src/config/settings.json",
			destinationPath: "skills/git-commits-push/src/config/settings.json",
		},
		{
			sourcePath: "system-prompt.md",
			destinationPath: "skills/git-commits-push/system-prompt.md",
		},
	],
	destinationDirectory: outputDirectory,
	sourceDirectory: skillDirectory,
});
