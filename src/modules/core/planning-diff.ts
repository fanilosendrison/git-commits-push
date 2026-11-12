import type { Settings } from "../../types.ts";

/** Keep the complete raw presentation; capacity partitioning owns resource guards. */
export function preparePlanningDiff(
	diff: string,
	_repository: string,
	_settings: Settings,
	_creation: boolean,
): string {
	return diff;
}
