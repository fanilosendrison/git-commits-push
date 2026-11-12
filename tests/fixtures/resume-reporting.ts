import {
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	spawnSync,
} from "node:child_process";
import { fileURLToPath } from "node:url";

/** A reporting acknowledgement cannot hide a failed or timed-out source resume. */
export function reportSourceResume(
	command: string,
	resumed: SpawnSyncReturns<string>,
	options: SpawnSyncOptionsWithStringEncoding,
) {
	if (
		resumed.error ||
		resumed.signal ||
		resumed.status !== 0 ||
		!/commit-outcome-\d+\.json/u.test(resumed.stdout ?? "")
	)
		return resumed;
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

/** Exercise both actual processes, each with the caller's unchanged timeout.
 * Planning retry delegations are returned untouched for bounded fixtures.
 */
export function resumeWithReporting(
	command: string,
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
) {
	return reportSourceResume(
		command,
		spawnSync(command, args, options),
		options,
	);
}
