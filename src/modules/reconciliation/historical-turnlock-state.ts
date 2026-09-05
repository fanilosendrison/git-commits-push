import * as fs from "node:fs";
import * as path from "node:path";
import { decodeTime } from "ulid";
import { z } from "zod";
import type {
	HistoricalRunRecord,
	NodeCutoverBlocker,
} from "./node-cutover-types.ts";

const ORCHESTRATOR_NAME = "git-commits-push-tl";
const RUN_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const RFC3339_TIMESTAMP_SCHEMA = z.string().datetime({ offset: true });

function isValidRunId(value: unknown): value is string {
	if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) return false;
	try {
		decodeTime(value);
		return true;
	} catch {
		return false;
	}
}

interface ClosureRecord {
	readonly closedAt: string;
	readonly reason: string;
	readonly runId: string;
}

interface ClosureLedgerResult {
	readonly blockers: readonly NodeCutoverBlocker[];
	readonly closures: ReadonlyMap<string, ClosureRecord>;
}

interface RunInspectionResult {
	readonly blockers: readonly NodeCutoverBlocker[];
	readonly classification: HistoricalRunRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function invalidClosureLedger(detail: string): ClosureLedgerResult {
	return {
		blockers: [
			{
				detail,
				kind: "invalid-closure-ledger",
				subject: "closure-ledger",
			},
		],
		closures: new Map(),
	};
}

function readClosureLedger(ledgerPath: string): ClosureLedgerResult {
	let contents: string;
	try {
		contents = fs.readFileSync(ledgerPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { blockers: [], closures: new Map() };
		}
		return invalidClosureLedger("closure ledger is unreadable");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch {
		return invalidClosureLedger("closure ledger is not valid JSON");
	}
	if (
		!isRecord(parsed) ||
		parsed.version !== 1 ||
		!Array.isArray(parsed.runs)
	) {
		return invalidClosureLedger(
			"closure ledger must contain version 1 and a runs array",
		);
	}

	const closures = new Map<string, ClosureRecord>();
	for (const value of parsed.runs) {
		if (!isRecord(value)) {
			return invalidClosureLedger("closure ledger run entries must be objects");
		}
		const { closedAt, reason, runId } = value;
		if (
			!isValidRunId(runId) ||
			typeof closedAt !== "string" ||
			!RFC3339_TIMESTAMP_SCHEMA.safeParse(closedAt).success ||
			typeof reason !== "string" ||
			reason.trim().length === 0
		) {
			return invalidClosureLedger(
				"closure ledger entries require a ULID runId, timestamp, and reason",
			);
		}
		if (closures.has(runId)) {
			return invalidClosureLedger(
				`closure ledger contains duplicate runId ${runId}`,
			);
		}
		closures.set(runId, { closedAt, reason, runId });
	}
	return { blockers: [], closures };
}

function inspectTurnlockLock(
	runDirectory: string,
	runId: string,
	nowEpochMs: number,
): NodeCutoverBlocker[] {
	const lockPath = path.join(runDirectory, ".lock");
	let parsed: unknown;
	try {
		const lockStat = fs.lstatSync(lockPath, { throwIfNoEntry: false });
		if (!lockStat) return [];
		if (!lockStat.isFile()) {
			throw new Error("lock is not a regular file");
		}
		parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
	} catch {
		return [
			{
				detail: "Turnlock lock is malformed or unreadable",
				kind: "malformed-turnlock-lock",
				subject: runId,
			},
		];
	}
	const leaseUntilEpochMs = isRecord(parsed)
		? parsed.leaseUntilEpochMs
		: undefined;
	if (
		typeof leaseUntilEpochMs !== "number" ||
		!Number.isFinite(leaseUntilEpochMs)
	) {
		return [
			{
				detail: "Turnlock lock has no finite leaseUntilEpochMs",
				kind: "malformed-turnlock-lock",
				subject: runId,
			},
		];
	}
	return nowEpochMs <= leaseUntilEpochMs
		? [
				{
					detail: "Turnlock run lease is still active",
					kind: "active-turnlock-lock",
					subject: runId,
				},
			]
		: [
				{
					detail: "expired Turnlock lock must be removed before cutover",
					kind: "stale-turnlock-lock",
					subject: runId,
				},
			];
}

function readTerminalEvent(
	runDirectory: string,
	runId: string,
): { readonly reason?: string; readonly terminalSuccess?: boolean } {
	const eventsPath = path.join(runDirectory, "events.ndjson");
	let contents: string;
	try {
		contents = fs.readFileSync(eventsPath, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? {}
			: { reason: "events.ndjson is unreadable" };
	}

	let finalEventIsTerminal = false;
	let terminalSuccess: boolean | undefined;
	for (const line of contents.split("\n")) {
		if (line.trim().length === 0) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return { reason: "events.ndjson contains malformed JSON" };
		}
		if (!isRecord(event)) {
			return { reason: "events.ndjson contains a non-object event" };
		}
		finalEventIsTerminal = event.eventType === "orchestrator_end";
		if (!finalEventIsTerminal) continue;
		if (
			event.runId !== runId ||
			event.orchestratorName !== ORCHESTRATOR_NAME ||
			typeof event.success !== "boolean"
		) {
			return { reason: "orchestrator_end event does not match its run" };
		}
		terminalSuccess = event.success;
	}
	return finalEventIsTerminal && terminalSuccess !== undefined
		? { terminalSuccess }
		: {};
}

function readStateIncompatibilityReason(
	runDirectory: string,
	runId: string,
): string | null {
	const statePath = path.join(runDirectory, "state.json");
	let state: unknown;
	try {
		state = JSON.parse(fs.readFileSync(statePath, "utf8"));
	} catch {
		return "state.json is missing, malformed, or unreadable";
	}
	if (!isRecord(state)) return "state.json is not an object";
	if (state.schemaVersion !== 2) {
		return `state schemaVersion ${String(state.schemaVersion)} is incompatible with Node cutover`;
	}
	if (state.runId !== runId || state.orchestratorName !== ORCHESTRATOR_NAME) {
		return "state.json identity does not match its run directory";
	}
	return null;
}

function inspectRun(
	runDirectory: string,
	runId: string,
	closure: ClosureRecord | undefined,
	nowEpochMs: number,
): RunInspectionResult {
	const blockers = inspectTurnlockLock(runDirectory, runId, nowEpochMs);
	if (closure) {
		return {
			blockers,
			classification: {
				classification: "explicitly-closed",
				reason: `${closure.closedAt}: ${closure.reason}`,
				runId,
			},
		};
	}

	const stateReason = readStateIncompatibilityReason(runDirectory, runId);
	if (stateReason) {
		return {
			blockers: [
				...blockers,
				{
					detail: stateReason,
					kind: "incompatible-run",
					subject: runId,
				},
			],
			classification: {
				classification: "rejected-incompatible",
				reason: stateReason,
				runId,
			},
		};
	}

	const terminal = readTerminalEvent(runDirectory, runId);
	if (terminal.reason) {
		return {
			blockers: [
				...blockers,
				{
					detail: terminal.reason,
					kind: "incompatible-run",
					subject: runId,
				},
			],
			classification: {
				classification: "rejected-incompatible",
				reason: terminal.reason,
				runId,
			},
		};
	}
	if (terminal.terminalSuccess === true) {
		return {
			blockers,
			classification: {
				classification: "drained",
				reason: "terminal orchestrator_end success event",
				runId,
			},
		};
	}

	const reason =
		terminal.terminalSuccess === false
			? "terminal orchestrator_end failure event requires explicit closure before cutover"
			: "historical non-terminal run requires explicit closure before cutover";
	return {
		blockers: [
			...blockers,
			{
				detail: reason,
				kind: "incompatible-run",
				subject: runId,
			},
		],
		classification: {
			classification: "rejected-incompatible",
			reason,
			runId,
		},
	};
}

export interface HistoricalTurnlockInspection {
	readonly blockers: readonly NodeCutoverBlocker[];
	readonly classifications: readonly HistoricalRunRecord[];
}

/** Classify persisted Turnlock runs and explicit closure records read-only. */
export function inspectHistoricalTurnlockState(
	runsDirectory: string,
	closureLedgerPath: string,
	nowEpochMs: number,
): HistoricalTurnlockInspection {
	const ledger = readClosureLedger(closureLedgerPath);
	const blockers: NodeCutoverBlocker[] = [...ledger.blockers];
	const classifications: HistoricalRunRecord[] = [];
	const classifiedRunIds = new Set<string>();
	let entries: fs.Dirent[] = [];
	try {
		entries = fs
			.readdirSync(runsDirectory, { withFileTypes: true })
			.sort((left, right) => compareStrings(left.name, right.name));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return {
				blockers: [
					...blockers,
					{
						detail: "Turnlock run root is unreadable",
						kind: "unreadable-run-root",
						subject: "turnlock-runs",
					},
				],
				classifications,
			};
		}
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || !isValidRunId(entry.name)) {
			blockers.push({
				detail: "Turnlock run root contains a non-run entry",
				kind: "unexpected-run-entry",
				subject: entry.name,
			});
			continue;
		}
		const result = inspectRun(
			path.join(runsDirectory, entry.name),
			entry.name,
			ledger.closures.get(entry.name),
			nowEpochMs,
		);
		blockers.push(...result.blockers);
		classifications.push(result.classification);
		classifiedRunIds.add(entry.name);
	}

	for (const closure of [...ledger.closures.values()].sort((left, right) =>
		compareStrings(left.runId, right.runId),
	)) {
		if (classifiedRunIds.has(closure.runId)) continue;
		classifications.push({
			classification: "explicitly-closed",
			reason: `${closure.closedAt}: ${closure.reason}`,
			runId: closure.runId,
		});
	}
	classifications.sort((left, right) =>
		compareStrings(left.runId, right.runId),
	);
	return { blockers, classifications };
}
