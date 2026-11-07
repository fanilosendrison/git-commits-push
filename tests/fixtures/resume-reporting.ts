import {
	type SpawnSyncOptionsWithStringEncoding,
	spawnSync,
} from "node:child_process";
import { fileURLToPath } from "node:url";

/** Exercise the real no-effect reporting acknowledgement after a source resume.
 * Planning retry delegations are returned untouched for the caller's bounded fixtures.
 */
export function resumeWithReporting(
	command: string,
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
) {
	const resumed = spawnSync(command, args, options);
	if (!/commit-outcome-\d+\.json/u.test(resumed.stdout ?? "")) return resumed;
	const bridge = fileURLToPath(
		new URL("../../src/entrypoints/turnlock-to-llm-bridge.ts", import.meta.url),
	);
	const reported = spawnSync(command, [bridge], {
		...options,
		input: resumed.stdout,
	});
	return {
		...reported,
		stdout: `${resumed.stdout}${reported.stdout}`,
		stderr: `${resumed.stderr}${reported.stderr}`,
	};
}
