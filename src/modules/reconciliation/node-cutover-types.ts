import type { ReconcilerPreflightBlockerKind } from "./reconciler-preflight.ts";

export type HistoricalRunClassification =
	| "drained"
	| "explicitly-closed"
	| "rejected-incompatible";

export type NodeCutoverBlockerKind =
	| "active-turnlock-lock"
	| "incompatible-run"
	| "invalid-closure-ledger"
	| "malformed-turnlock-lock"
	| "stale-turnlock-lock"
	| "unreadable-run-root"
	| "unexpected-run-entry"
	| ReconcilerPreflightBlockerKind;

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
