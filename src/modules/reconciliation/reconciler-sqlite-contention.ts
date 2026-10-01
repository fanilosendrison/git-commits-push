import type { DatabaseSync } from "node:sqlite";

function isSqliteBusy(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
		"errcode" in error &&
		(error as { errcode?: number }).errcode === 5
	);
}

function waitSynchronously(milliseconds: number): void {
	const signal = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(signal, 0, 0, milliseconds);
}

/** Enable WAL while bounding contention among simultaneous database openers. */
export function enableWalWithBoundedContentionRetry(db: DatabaseSync): void {
	for (let attempt = 0; attempt < 8; attempt++) {
		try {
			db.exec("PRAGMA journal_mode = WAL");
			return;
		} catch (error) {
			if (!isSqliteBusy(error) || attempt === 7) throw error;
			waitSynchronously(10 * (attempt + 1));
		}
	}
}
