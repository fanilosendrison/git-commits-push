#!/usr/bin/env node
/**
 * Development launcher for git-commits-push.
 *
 * The shared public launcher registers reconciliation before invoking the
 * development-only build callback. Installed releases bypass this adapter and
 * execute their already-compiled entrypoint directly.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPublicLauncher } from "../src/modules/reconciliation/public-launcher.ts";
import { buildOnce } from "./start-node-internals/build-once.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const applicationDirectory = path.resolve(scriptDirectory, "..");
const packageDirectories = [
	path.join(applicationDirectory, "packages", "node-runtime"),
	path.join(applicationDirectory, "packages", "trust"),
];

process.exitCode = await runPublicLauncher({
	compiledApplicationDirectory: path.join(applicationDirectory, "dist"),
	passthroughArguments: process.argv.slice(2),
	prepareRuntime: async (abortSignal) =>
		await buildOnce({
			abortSignal,
			packageDirectories,
			scriptDirectory,
			skillDirectory: applicationDirectory,
		}),
});
