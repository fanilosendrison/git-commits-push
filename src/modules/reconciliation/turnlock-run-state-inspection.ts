import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { stateSchema } from "../../config/state-schema.ts";
import { GCP_TURNLOCK_ORCHESTRATOR_NAME } from "./legacy-global-run-paths.ts";

const RUN_STATE_FILE_NAME = "state.json";
const RUN_DATABASE_FILE_NAME = "turnlock.sqlite3";
const SQLITE_TRANSIENT_SUFFIXES = ["-journal", "-shm", "-wal"] as const;

export type TurnlockRunInspectionErrorKind =
	| "invalid-run-state"
	| "turnlock-lock-present"
	| "uncheckpointed-turnlock-db";

export class TurnlockRunInspectionError extends Error {
	readonly kind: TurnlockRunInspectionErrorKind;

	constructor(kind: TurnlockRunInspectionErrorKind, message: string) {
		super(message);
		this.name = "TurnlockRunInspectionError";
		this.kind = kind;
	}
}

export interface InspectedTurnlockRun {
	readonly ownershipHeld: boolean;
	readonly scope:
		| "global"
		| "targeted"
		| "targeted-create"
		| "worktree"
		| "prepared-merge";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function databaseFingerprint(filePath: string): string {
	const stat = fs.statSync(filePath, { bigint: true });
	return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function transientSqlitePaths(databasePath: string): readonly string[] {
	return SQLITE_TRANSIENT_SUFFIXES.map((suffix) => `${databasePath}${suffix}`)
		.filter((candidate) => fs.existsSync(candidate))
		.sort();
}

function invalidRunState(message: string): never {
	throw new TurnlockRunInspectionError("invalid-run-state", message);
}

function parseApplicationScope(
	rawState: unknown,
	runId: string,
): InspectedTurnlockRun["scope"] {
	if (
		!isRecord(rawState) ||
		rawState.runId !== runId ||
		rawState.orchestratorName !== GCP_TURNLOCK_ORCHESTRATOR_NAME ||
		!Number.isInteger(rawState.schemaVersion) ||
		![2, 3, 4].includes(Number(rawState.schemaVersion))
	) {
		invalidRunState("Turnlock state identity or schemaVersion is invalid");
	}
	const parsed = stateSchema.safeParse(rawState.data);
	if (!parsed.success) {
		invalidRunState("git-commits-push state payload is invalid");
	}
	return parsed.data.invocationScope.kind;
}

function readJsonFile(filePath: string): unknown {
	const stats = fs.lstatSync(filePath);
	if (!stats.isFile() || stats.isSymbolicLink()) {
		invalidRunState(
			`${path.basename(filePath)} is not a physical regular file`,
		);
	}
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
	} catch {
		invalidRunState(`${path.basename(filePath)} is not valid JSON`);
	}
}

function inspectFileBackedRun(
	runDirectory: string,
	runId: string,
): InspectedTurnlockRun {
	return {
		ownershipHeld: false,
		scope: parseApplicationScope(
			readJsonFile(path.join(runDirectory, RUN_STATE_FILE_NAME)),
			runId,
		),
	};
}

function assertSupportedSchema(database: DatabaseSync): void {
	const schema = database
		.prepare("SELECT schema_version FROM schema_metadata WHERE singleton = 1")
		.get() as { readonly schema_version?: number } | undefined;
	if (
		schema?.schema_version !== 1 &&
		schema?.schema_version !== 2 &&
		schema?.schema_version !== 3
	) {
		invalidRunState("Turnlock SQLite schema version is unsupported");
	}
}

function assertDatabaseIdentity(database: DatabaseSync, runId: string): void {
	const incarnation = database
		.prepare(
			"SELECT run_id, orchestrator_name FROM run_incarnation WHERE singleton = 1",
		)
		.get() as
		| { readonly orchestrator_name?: string; readonly run_id?: string }
		| undefined;
	if (
		incarnation?.run_id !== runId ||
		incarnation.orchestrator_name !== GCP_TURNLOCK_ORCHESTRATOR_NAME
	) {
		invalidRunState("Turnlock SQLite run identity is invalid");
	}
}

function readAuthoritativeState(
	database: DatabaseSync,
	runId: string,
): InspectedTurnlockRun["scope"] {
	const row = database
		.prepare(
			"SELECT state_schema_version, state_json, state_digest FROM run_state WHERE singleton = 1",
		)
		.get() as
		| {
				readonly state_digest?: string;
				readonly state_json?: string;
				readonly state_schema_version?: number;
		  }
		| undefined;
	if (
		typeof row?.state_json !== "string" ||
		typeof row.state_digest !== "string" ||
		typeof row.state_schema_version !== "number"
	) {
		invalidRunState("Turnlock SQLite state row is invalid");
	}
	const digest = `sha256:${createHash("sha256").update(row.state_json).digest("hex")}`;
	if (row.state_digest !== digest) {
		invalidRunState("Turnlock SQLite state digest does not match");
	}
	let rawState: unknown;
	try {
		rawState = JSON.parse(row.state_json) as unknown;
	} catch {
		invalidRunState("Turnlock SQLite state is not valid JSON");
	}
	if (
		!isRecord(rawState) ||
		rawState.schemaVersion !== row.state_schema_version
	) {
		invalidRunState("Turnlock SQLite state schema metadata does not match");
	}
	return parseApplicationScope(rawState, runId);
}

function ownershipIsHeld(database: DatabaseSync): boolean {
	const ownership = database
		.prepare(
			"SELECT ownership_status, owner_token, owner_pid, acquired_at_epoch_ms, lease_until_epoch_ms FROM run_ownership WHERE singleton = 1",
		)
		.get() as
		| {
				readonly acquired_at_epoch_ms?: number | null;
				readonly lease_until_epoch_ms?: number | null;
				readonly owner_pid?: number | null;
				readonly owner_token?: string | null;
				readonly ownership_status?: string;
		  }
		| undefined;
	if (
		ownership?.ownership_status !== "FREE" &&
		ownership?.ownership_status !== "HELD"
	) {
		invalidRunState("Turnlock SQLite ownership row is invalid");
	}
	if (
		ownership.ownership_status === "FREE" &&
		(ownership.owner_token !== null ||
			ownership.owner_pid !== null ||
			ownership.acquired_at_epoch_ms !== null ||
			ownership.lease_until_epoch_ms !== null)
	) {
		invalidRunState("Turnlock SQLite FREE ownership row is incoherent");
	}
	return ownership.ownership_status === "HELD";
}

function inspectSqliteBackedRun(
	runDirectory: string,
	runId: string,
): InspectedTurnlockRun {
	const databasePath = path.join(runDirectory, RUN_DATABASE_FILE_NAME);
	const databaseStats = fs.lstatSync(databasePath);
	if (!databaseStats.isFile() || databaseStats.isSymbolicLink()) {
		invalidRunState("Turnlock database is not a physical regular file");
	}
	if (transientSqlitePaths(databasePath).length > 0) {
		throw new TurnlockRunInspectionError(
			"uncheckpointed-turnlock-db",
			"Turnlock SQLite transient state prevents immutable inspection",
		);
	}
	const before = databaseFingerprint(databasePath);
	const immutableLocation = pathToFileURL(databasePath);
	immutableLocation.searchParams.set("immutable", "1");
	let database: DatabaseSync;
	try {
		database = new DatabaseSync(immutableLocation, { readOnly: true });
	} catch {
		invalidRunState("Turnlock SQLite database cannot be opened read-only");
	}
	let inspected: InspectedTurnlockRun;
	try {
		assertSupportedSchema(database);
		assertDatabaseIdentity(database, runId);
		inspected = {
			ownershipHeld: ownershipIsHeld(database),
			scope: readAuthoritativeState(database, runId),
		};
	} finally {
		database.close();
	}
	if (
		transientSqlitePaths(databasePath).length > 0 ||
		databaseFingerprint(databasePath) !== before
	) {
		throw new TurnlockRunInspectionError(
			"uncheckpointed-turnlock-db",
			"Turnlock SQLite database changed during immutable inspection",
		);
	}
	return inspected;
}

/** Checkpoint selected run databases after external proof that no process is live. */
export function checkpointTurnlockRunDatabases(
	runsDirectory: string,
	runIds: readonly string[],
): void {
	for (const runId of runIds) {
		const runDirectory = path.join(runsDirectory, runId);
		if (fs.existsSync(path.join(runDirectory, ".lock"))) {
			throw new TurnlockRunInspectionError(
				"turnlock-lock-present",
				"historical Turnlock lock must be resolved before checkpoint",
			);
		}
		const databasePath = path.join(runDirectory, RUN_DATABASE_FILE_NAME);
		const stats = fs.lstatSync(databasePath);
		if (!stats.isFile() || stats.isSymbolicLink()) {
			invalidRunState("Turnlock database is not a physical regular file");
		}
		const database = new DatabaseSync(databasePath);
		try {
			database.exec("PRAGMA busy_timeout = 5000");
			const checkpoint = database
				.prepare("PRAGMA wal_checkpoint(TRUNCATE)")
				.get() as { readonly busy?: number } | undefined;
			if (checkpoint?.busy !== 0) {
				throw new TurnlockRunInspectionError(
					"uncheckpointed-turnlock-db",
					"Turnlock SQLite refused an exclusive offline checkpoint",
				);
			}
		} finally {
			database.close();
		}
		if (transientSqlitePaths(databasePath).length > 0) {
			throw new TurnlockRunInspectionError(
				"uncheckpointed-turnlock-db",
				"Turnlock SQLite transient files remain after checkpoint",
			);
		}
	}
}

/** Convert authoritative inspection failure or held ownership into a reason. */
export function readTurnlockRunIncompatibilityReason(
	runDirectory: string,
	runId: string,
): string | null {
	try {
		return inspectTurnlockRunDirectory(runDirectory, runId).ownershipHeld
			? "Turnlock SQLite ownership is still HELD"
			: null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** Read one Turnlock run's authoritative application scope without mutation. */
export function inspectTurnlockRunDirectory(
	runDirectory: string,
	runId: string,
): InspectedTurnlockRun {
	const stats = fs.lstatSync(runDirectory);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		invalidRunState("run path is not a physical directory");
	}
	if (fs.existsSync(path.join(runDirectory, ".lock"))) {
		throw new TurnlockRunInspectionError(
			"turnlock-lock-present",
			"historical Turnlock lock must be resolved before revocation",
		);
	}
	return fs.existsSync(path.join(runDirectory, RUN_DATABASE_FILE_NAME))
		? inspectSqliteBackedRun(runDirectory, runId)
		: inspectFileBackedRun(runDirectory, runId);
}
