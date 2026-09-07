import { mkdirSync, rmdirSync } from "node:fs";
import path from "node:path";

export const STATE_CUTOVER_LOCK_SUFFIX = ".migration-lock";

/** Resolve the lock shared by default-state migration and launcher admission. */
export function resolveStateCutoverLockPath(applicationStateDirectory) {
	if (!path.isAbsolute(applicationStateDirectory)) {
		throw new Error("Application state directory must be an absolute path.");
	}
	return `${path.normalize(applicationStateDirectory)}${STATE_CUTOVER_LOCK_SUFFIX}`;
}

/** Acquire the fail-closed, process-external state cutover lock. */
export function acquireStateCutoverLock(applicationStateDirectory) {
	const lockPath = resolveStateCutoverLockPath(applicationStateDirectory);
	mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	try {
		mkdirSync(lockPath, { mode: 0o700 });
	} catch (error) {
		throw new Error(`State migration lock is already held: ${lockPath}`, {
			cause: error,
		});
	}
	return lockPath;
}

/** Release a previously acquired state cutover lock without masking outcomes. */
export function releaseStateCutoverLock(lockPath) {
	try {
		rmdirSync(lockPath);
	} catch {
		// A stale lock fails closed and requires operator inspection.
	}
}
