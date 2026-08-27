import type { ChildProcess } from "node:child_process";

const supportsProcessGroups = process.platform !== "win32";

export const usesIsolatedProcessGroup = supportsProcessGroups;

export function signalProcessTree(
	child: ChildProcess,
	signal: NodeJS.Signals,
): void {
	if (child.pid === undefined) return;

	if (supportsProcessGroups) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch (error) {
			if (!isMissingProcessError(error)) throw error;
		}
	}

	try {
		child.kill(signal);
	} catch (error) {
		if (!isMissingProcessError(error)) throw error;
	}
}

function isMissingProcessError(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ESRCH"
	);
}
