#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installStandalone } from "../src/modules/installation/standalone-installer.ts";
import { assertLegacyGlobalRunCutoverComplete } from "../src/modules/reconciliation/legacy-global-run-cutover.ts";
import { resolveLegacyGlobalRunCutoverPaths } from "../src/modules/reconciliation/legacy-global-run-paths.ts";

const sourceDirectory = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const pnpmCliPath = process.env.npm_execpath;
if (!pnpmCliPath) {
	throw new Error(
		"pnpm did not expose npm_execpath; run `pnpm run install:standalone`.",
	);
}
assertLegacyGlobalRunCutoverComplete(
	resolveLegacyGlobalRunCutoverPaths(process.env),
);

const result = await installStandalone({
	pnpmCliPath,
	sourceDirectory,
});
process.stdout.write(
	`Installed git-commits-push ${result.releaseName} at ${result.paths.publicExecutablePath}\n`,
);
