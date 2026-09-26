import * as fs from "node:fs";
import * as path from "node:path";
import { TURNLOCK_MANAGEMENT_DIRECTORY_NAMES } from "./legacy-global-run-paths.ts";
import {
	LEGACY_GLOBAL_REVOCATION_KIND,
	parseLegacyGlobalRevocationTombstone,
	revokeLegacyGlobalRun,
} from "./legacy-global-run-revocation.ts";
import { isValidTurnlockRunId } from "./turnlock-run-identity.ts";
import {
	checkpointTurnlockRunDatabases,
	inspectTurnlockRunDirectory,
	TurnlockRunInspectionError,
} from "./turnlock-run-state-inspection.ts";

const TURNLOCK_MANAGEMENT_ENTRIES: ReadonlySet<string> = new Set(
	TURNLOCK_MANAGEMENT_DIRECTORY_NAMES,
);

export { LEGACY_GLOBAL_REVOCATION_KIND };

export type LegacyGlobalCutoverBlockerKind =
	| "invalid-run-state"
	| "invalid-revocation-tombstone"
	| "quarantine-collision"
	| "turnlock-lock-present"
	| "uncheckpointed-turnlock-db"
	| "unexpected-entry"
	| "unreadable-path";

export interface LegacyGlobalCutoverBlocker {
	readonly detail: string;
	readonly kind: LegacyGlobalCutoverBlockerKind;
	readonly runId: string;
}

export interface LegacyGlobalRunCutoverPaths {
	readonly quarantineDirectory: string;
	readonly runsDirectory: string;
}

export interface LegacyGlobalRunCutoverReport {
	readonly blockers: readonly LegacyGlobalCutoverBlocker[];
	readonly candidates: readonly string[];
	readonly ready: boolean;
	readonly revoked: readonly string[];
	readonly safe: readonly string[];
	readonly version: 1;
}

export interface CutoverLegacyGlobalRunsOptions
	extends LegacyGlobalRunCutoverPaths {
	readonly confirmedNoLiveExecution: boolean;
	readonly revokedAt: string;
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function requireAbsolutePath(value: string, label: string): string {
	if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute.`);
	return path.normalize(value);
}

function readDirectoryEntries(
	directory: string,
	missingIsEmpty: boolean,
): { readonly entries: readonly fs.Dirent[]; readonly unreadable: boolean } {
	try {
		const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
		if (stats === undefined) {
			return missingIsEmpty
				? { entries: [], unreadable: false }
				: { entries: [], unreadable: true };
		}
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			return { entries: [], unreadable: true };
		}
		return {
			entries: fs
				.readdirSync(directory, { withFileTypes: true })
				.sort((left, right) => compareStrings(left.name, right.name)),
			unreadable: false,
		};
	} catch {
		return { entries: [], unreadable: true };
	}
}

function inspectionBlocker(
	runId: string,
	error: unknown,
): LegacyGlobalCutoverBlocker {
	if (error instanceof TurnlockRunInspectionError) {
		return { detail: error.message, kind: error.kind, runId };
	}
	return {
		detail: error instanceof Error ? error.message : String(error),
		kind: "invalid-run-state",
		runId,
	};
}

function inspectCanonicalDirectory(
	runId: string,
	runPath: string,
	quarantineEntry: fs.Dirent | undefined,
	candidates: Set<string>,
	safe: Set<string>,
	blockers: LegacyGlobalCutoverBlocker[],
): void {
	if (quarantineEntry !== undefined) {
		blockers.push({
			detail: "canonical and quarantined run paths both exist",
			kind: "quarantine-collision",
			runId,
		});
		return;
	}
	try {
		const inspected = inspectTurnlockRunDirectory(runPath, runId);
		if (inspected.ownershipHeld) {
			blockers.push({
				detail: "Turnlock SQLite ownership is still HELD",
				kind: "turnlock-lock-present",
				runId,
			});
		} else if (inspected.scope === "global") candidates.add(runId);
		else safe.add(runId);
	} catch (error) {
		blockers.push(inspectionBlocker(runId, error));
	}
}

function inspectCanonicalTombstone(
	runId: string,
	filePath: string,
	quarantineDirectory: string,
	quarantineEntry: fs.Dirent | undefined,
	revoked: Set<string>,
	blockers: LegacyGlobalCutoverBlocker[],
): void {
	try {
		parseLegacyGlobalRevocationTombstone(filePath, runId);
		if (
			quarantineEntry === undefined ||
			!quarantineEntry.isDirectory() ||
			quarantineEntry.isSymbolicLink()
		) {
			throw new Error("matching quarantined run directory is absent");
		}
		const inspected = inspectTurnlockRunDirectory(
			path.join(quarantineDirectory, runId),
			runId,
		);
		if (inspected.scope !== "global") {
			throw new Error("revoked run does not carry legacy global scope");
		}
		revoked.add(runId);
	} catch (error) {
		blockers.push({
			detail: error instanceof Error ? error.message : String(error),
			kind: "invalid-revocation-tombstone",
			runId,
		});
	}
}

function inspectInterruptedRevocations(
	quarantineEntries: ReadonlyMap<string, fs.Dirent>,
	runsDirectory: string,
	quarantineDirectory: string,
	revoked: ReadonlySet<string>,
	candidates: Set<string>,
	blockers: LegacyGlobalCutoverBlocker[],
): void {
	for (const [runId, entry] of [...quarantineEntries].sort(([left], [right]) =>
		compareStrings(left, right),
	)) {
		if (revoked.has(runId)) continue;
		if (
			!isValidTurnlockRunId(runId) ||
			!entry.isDirectory() ||
			entry.isSymbolicLink()
		) {
			blockers.push({
				detail: "quarantine contains an unexpected entry",
				kind: "unexpected-entry",
				runId,
			});
			continue;
		}
		if (fs.existsSync(path.join(runsDirectory, runId))) continue;
		try {
			const inspected = inspectTurnlockRunDirectory(
				path.join(quarantineDirectory, runId),
				runId,
			);
			if (inspected.ownershipHeld) {
				throw new Error("Turnlock SQLite ownership is still HELD");
			}
			if (inspected.scope !== "global") {
				throw new Error("interrupted revocation does not carry global scope");
			}
			candidates.add(runId);
		} catch (error) {
			blockers.push(inspectionBlocker(runId, error));
		}
	}
}

/** Inspect whether any canonical historical global Turnlock run remains executable. */
export function inspectLegacyGlobalRunCutover(
	options: LegacyGlobalRunCutoverPaths,
): LegacyGlobalRunCutoverReport {
	const runsDirectory = requireAbsolutePath(
		options.runsDirectory,
		"Turnlock runs directory",
	);
	const quarantineDirectory = requireAbsolutePath(
		options.quarantineDirectory,
		"Legacy-global quarantine directory",
	);
	const blockers: LegacyGlobalCutoverBlocker[] = [];
	const candidates = new Set<string>();
	const revoked = new Set<string>();
	const safe = new Set<string>();
	const quarantineRead = readDirectoryEntries(quarantineDirectory, true);
	if (quarantineRead.unreadable) {
		blockers.push({
			detail: "legacy-global quarantine is unreadable",
			kind: "unreadable-path",
			runId: "quarantine",
		});
	}
	const quarantineEntries = new Map(
		quarantineRead.entries.map((entry) => [entry.name, entry]),
	);
	const runsRead = readDirectoryEntries(runsDirectory, true);
	if (runsRead.unreadable) {
		blockers.push({
			detail: "Turnlock run namespace is unreadable",
			kind: "unreadable-path",
			runId: "run-namespace",
		});
	}

	for (const entry of runsRead.entries) {
		if (TURNLOCK_MANAGEMENT_ENTRIES.has(entry.name)) continue;
		if (!isValidTurnlockRunId(entry.name)) {
			blockers.push({
				detail: "Turnlock run namespace contains an unexpected entry",
				kind: "unexpected-entry",
				runId: entry.name,
			});
			continue;
		}
		const canonicalPath = path.join(runsDirectory, entry.name);
		if (entry.isDirectory() && !entry.isSymbolicLink()) {
			inspectCanonicalDirectory(
				entry.name,
				canonicalPath,
				quarantineEntries.get(entry.name),
				candidates,
				safe,
				blockers,
			);
		} else if (entry.isFile()) {
			inspectCanonicalTombstone(
				entry.name,
				canonicalPath,
				quarantineDirectory,
				quarantineEntries.get(entry.name),
				revoked,
				blockers,
			);
		} else {
			blockers.push({
				detail:
					"canonical run path is neither a directory nor a tombstone file",
				kind: "unexpected-entry",
				runId: entry.name,
			});
		}
	}
	inspectInterruptedRevocations(
		quarantineEntries,
		runsDirectory,
		quarantineDirectory,
		revoked,
		candidates,
		blockers,
	);
	const sortedBlockers = blockers.sort((left, right) =>
		compareStrings(
			`${left.runId}:${left.kind}`,
			`${right.runId}:${right.kind}`,
		),
	);
	const sortedCandidates = [...candidates].sort(compareStrings);
	return {
		blockers: sortedBlockers,
		candidates: sortedCandidates,
		ready: sortedBlockers.length === 0 && sortedCandidates.length === 0,
		revoked: [...revoked].sort(compareStrings),
		safe: [...safe].sort(compareStrings),
		version: 1,
	};
}

/** Refuse release activation while legacy global authority remains reachable. */
export function assertLegacyGlobalRunCutoverComplete(
	options: LegacyGlobalRunCutoverPaths,
): void {
	const report = inspectLegacyGlobalRunCutover(options);
	if (!report.ready) {
		throw new Error(
			"Legacy global Turnlock runs remain executable; run `pnpm run cutover:legacy-global-runs` and complete the documented offline cutover before release activation.",
		);
	}
}

/** Quarantine every legacy global run and occupy its canonical path with a tombstone. */
export function cutoverLegacyGlobalRuns(
	options: CutoverLegacyGlobalRunsOptions,
): LegacyGlobalRunCutoverReport {
	if (!options.confirmedNoLiveExecution) {
		throw new Error(
			"Legacy global cutover requires explicit confirmation that no historical execution is live.",
		);
	}
	if (new Date(options.revokedAt).toISOString() !== options.revokedAt) {
		throw new Error(
			"Legacy global revocation timestamp must be canonical ISO-8601.",
		);
	}
	const initial = inspectLegacyGlobalRunCutover(options);
	const hardBlockers = initial.blockers.filter(
		({ kind }) => kind !== "uncheckpointed-turnlock-db",
	);
	if (hardBlockers.length > 0) {
		throw new Error(
			`Legacy global cutover blockers: ${hardBlockers.map(({ kind, runId }) => `${runId}:${kind}`).join(", ")}`,
		);
	}
	const checkpointRunIds = initial.blockers
		.filter(({ kind }) => kind === "uncheckpointed-turnlock-db")
		.map(({ runId }) => runId);
	if (checkpointRunIds.length > 0) {
		checkpointTurnlockRunDatabases(options.runsDirectory, checkpointRunIds);
	}
	const before = inspectLegacyGlobalRunCutover(options);
	if (before.blockers.length > 0) {
		throw new Error(
			`Legacy global cutover blockers remain after checkpoint: ${before.blockers.map(({ kind, runId }) => `${runId}:${kind}`).join(", ")}`,
		);
	}
	if (before.candidates.length === 0) return before;
	fs.mkdirSync(options.quarantineDirectory, { mode: 0o700, recursive: true });
	const quarantineStats = fs.lstatSync(options.quarantineDirectory);
	if (!quarantineStats.isDirectory() || quarantineStats.isSymbolicLink()) {
		throw new Error("Legacy-global quarantine must be a physical directory.");
	}
	for (const runId of before.candidates) {
		revokeLegacyGlobalRun({
			quarantineDirectory: options.quarantineDirectory,
			revokedAt: options.revokedAt,
			runId,
			runsDirectory: options.runsDirectory,
		});
	}
	const after = inspectLegacyGlobalRunCutover(options);
	if (!after.ready) {
		throw new Error(
			"Legacy global cutover did not reach a fully revoked state.",
		);
	}
	return after;
}
