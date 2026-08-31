import * as fs from "node:fs";
import * as path from "node:path";

const ORCHESTRATOR_NAME = "git-commits-push-tl";
const RUN_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const QUEUE_LOCK_STALE_AFTER_MS = 40_000;

export type HistoricalRunClassification =
	| "drained"
	| "explicitly-closed"
	| "rejected-incompatible";

export type NodeCutoverBlockerKind =
	| "active-turnlock-lock"
	| "incompatible-run"
	| "invalid-closure-ledger"
	| "live-queue-lock"
	| "malformed-queue-lock"
	| "malformed-turnlock-lock"
	| "pending-order"
	| "stale-queue-lock"
	| "stale-turnlock-lock"
	| "unreadable-order-state"
	| "unreadable-run-root"
	| "unexpected-run-entry";

export interface HistoricalRunRecord {
	readonly classification: HistoricalRunClassification;
	readonly reason: string;
	readonly runId: string;
}

export interface NodeCutoverBlocker {
	readonly detail: string;
	readonly kind: NodeCutoverBlockerKind;
	readonly subject: string;
}

export interface NodeCutoverPreflightReport {
	readonly blockers: readonly NodeCutoverBlocker[];
	readonly classifications: readonly HistoricalRunRecord[];
	readonly ready: boolean;
	readonly summary: {
		readonly drained: number;
		readonly explicitlyClosed: number;
		readonly rejectedIncompatible: number;
	};
	readonly version: 1;
}

export interface NodeCutoverPreflightOptions {
	readonly closureLedgerPath: string;
	readonly nowEpochMs: number;
	readonly orderStateDirectory: string;
	readonly runsDirectory: string;
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
	if (!fs.existsSync(ledgerPath)) {
		return { blockers: [], closures: new Map() };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
	} catch {
		return invalidClosureLedger("closure ledger is not readable JSON");
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
			typeof runId !== "string" ||
			!RUN_ID_PATTERN.test(runId) ||
			typeof closedAt !== "string" ||
			!Number.isFinite(Date.parse(closedAt)) ||
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
	if (!fs.existsSync(lockPath)) return [];

	let parsed: unknown;
	try {
		if (!fs.lstatSync(lockPath).isFile()) {
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
	if (nowEpochMs <= leaseUntilEpochMs) {
		return [
			{
				detail: "Turnlock run lease is still active",
				kind: "active-turnlock-lock",
				subject: runId,
			},
		];
	}
	return [
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
	if (!fs.existsSync(eventsPath)) return {};

	let contents: string;
	try {
		contents = fs.readFileSync(eventsPath, "utf8");
	} catch {
		return { reason: "events.ndjson is unreadable" };
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

function incompatibleRunReason(runDirectory: string, runId: string): string {
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
	return "historical non-terminal run requires explicit closure before cutover";
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
	if (terminal.terminalSuccess !== undefined) {
		return {
			blockers,
			classification: {
				classification: "drained",
				reason: terminal.terminalSuccess
					? "terminal orchestrator_end success event"
					: "terminal orchestrator_end failure event",
				runId,
			},
		};
	}

	const reason = incompatibleRunReason(runDirectory, runId);
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

function inspectRuns(
	runsDirectory: string,
	closures: ReadonlyMap<string, ClosureRecord>,
	nowEpochMs: number,
): {
	readonly blockers: readonly NodeCutoverBlocker[];
	readonly classifications: readonly HistoricalRunRecord[];
} {
	const blockers: NodeCutoverBlocker[] = [];
	const classifications: HistoricalRunRecord[] = [];
	const classifiedRunIds = new Set<string>();
	if (fs.existsSync(runsDirectory)) {
		let entries: fs.Dirent[];
		try {
			entries = fs
				.readdirSync(runsDirectory, { withFileTypes: true })
				.sort((left, right) => compareStrings(left.name, right.name));
		} catch {
			return {
				blockers: [
					{
						detail: "Turnlock run root is unreadable",
						kind: "unreadable-run-root",
						subject: "turnlock-runs",
					},
				],
				classifications,
			};
		}

		for (const entry of entries) {
			if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) {
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
				closures.get(entry.name),
				nowEpochMs,
			);
			blockers.push(...result.blockers);
			classifications.push(result.classification);
			classifiedRunIds.add(entry.name);
		}
	}

	for (const closure of [...closures.values()].sort((left, right) =>
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

function inspectOrderState(
	orderStateDirectory: string,
	nowEpochMs: number,
): NodeCutoverBlocker[] {
	if (!fs.existsSync(orderStateDirectory)) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs
			.readdirSync(orderStateDirectory, { withFileTypes: true })
			.sort((left, right) => compareStrings(left.name, right.name));
	} catch {
		return [
			{
				detail: "order state directory is unreadable",
				kind: "unreadable-order-state",
				subject: "order-state",
			},
		];
	}

	const blockers: NodeCutoverBlocker[] = [];
	const queueLock = entries.find((entry) => entry.name === "running.lock");
	if (queueLock) {
		const lockPath = path.join(orderStateDirectory, queueLock.name);
		try {
			if (!queueLock.isFile()) throw new Error("lock is not a regular file");
			const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, "utf8"));
			if (
				!isRecord(parsed) ||
				typeof parsed.runId !== "string" ||
				typeof parsed.callerName !== "string" ||
				typeof parsed.timestamp !== "number" ||
				!Number.isFinite(parsed.timestamp)
			) {
				throw new Error("lock metadata is malformed");
			}
			const ageMs = nowEpochMs - fs.statSync(lockPath).mtimeMs;
			blockers.push(
				ageMs <= QUEUE_LOCK_STALE_AFTER_MS
					? {
							detail: "queue lock heartbeat is still live",
							kind: "live-queue-lock",
							subject: "running.lock",
						}
					: {
							detail: "stale queue lock must be removed before cutover",
							kind: "stale-queue-lock",
							subject: "running.lock",
						},
			);
		} catch {
			blockers.push({
				detail: "queue lock is malformed or unreadable",
				kind: "malformed-queue-lock",
				subject: "running.lock",
			});
		}
	}

	for (const entry of entries) {
		if (!entry.name.startsWith("order-")) continue;
		blockers.push({
			detail: "queued order artifact must be drained before cutover",
			kind: "pending-order",
			subject: entry.name,
		});
	}
	return blockers;
}

export function inspectNodeCutoverState(
	options: NodeCutoverPreflightOptions,
): NodeCutoverPreflightReport {
	if (!Number.isFinite(options.nowEpochMs)) {
		throw new TypeError("nowEpochMs must be finite");
	}
	const ledger = readClosureLedger(options.closureLedgerPath);
	const runs = inspectRuns(
		options.runsDirectory,
		ledger.closures,
		options.nowEpochMs,
	);
	const blockers = [
		...ledger.blockers,
		...runs.blockers,
		...inspectOrderState(options.orderStateDirectory, options.nowEpochMs),
	];
	const summary = {
		drained: runs.classifications.filter(
			(record) => record.classification === "drained",
		).length,
		explicitlyClosed: runs.classifications.filter(
			(record) => record.classification === "explicitly-closed",
		).length,
		rejectedIncompatible: runs.classifications.filter(
			(record) => record.classification === "rejected-incompatible",
		).length,
	};
	return {
		blockers,
		classifications: runs.classifications,
		ready: blockers.length === 0,
		summary,
		version: 1,
	};
}
