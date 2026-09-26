import { decodeTime } from "ulid";

const TURNLOCK_RUN_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Return whether a value is one canonical Turnlock ULID run identity. */
export function isValidTurnlockRunId(value: unknown): value is string {
	if (typeof value !== "string" || !TURNLOCK_RUN_ID_PATTERN.test(value)) {
		return false;
	}
	try {
		decodeTime(value);
		return true;
	} catch {
		return false;
	}
}
