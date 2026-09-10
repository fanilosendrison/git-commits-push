import type { DatabaseSync } from "node:sqlite";

/** Execute one short immediate coordinator transaction. */
export function runReconcilerTransaction<T>(
	db: DatabaseSync,
	operation: () => T,
): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const value = operation();
		db.exec("COMMIT");
		return value;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// Preserve the original transition failure.
		}
		throw error;
	}
}
