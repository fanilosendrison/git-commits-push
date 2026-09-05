import { inspectHistoricalTurnlockState } from "../modules/reconciliation/historical-turnlock-state.ts";
import type {
	NodeCutoverPreflightOptions,
	NodeCutoverPreflightReport,
} from "../modules/reconciliation/node-cutover-types.ts";
import { inspectReconciliationPreflightState } from "../modules/reconciliation/reconciler-preflight.ts";

export type {
	HistoricalRunClassification,
	HistoricalRunRecord,
	NodeCutoverBlocker,
	NodeCutoverBlockerKind,
	NodeCutoverPreflightOptions,
	NodeCutoverPreflightReport,
} from "../modules/reconciliation/node-cutover-types.ts";

/** Read-only compatibility gate for historical Turnlock and reconciler state. */
export function inspectNodeCutoverState(
	options: NodeCutoverPreflightOptions,
): NodeCutoverPreflightReport {
	if (!Number.isFinite(options.nowEpochMs)) {
		throw new TypeError("nowEpochMs must be finite");
	}
	const historical = inspectHistoricalTurnlockState(
		options.runsDirectory,
		options.closureLedgerPath,
		options.nowEpochMs,
	);
	const blockers = [
		...historical.blockers,
		...inspectReconciliationPreflightState(
			options.orderStateDirectory,
			options.nowEpochMs,
		),
	];
	const summary = {
		drained: historical.classifications.filter(
			(record) => record.classification === "drained",
		).length,
		explicitlyClosed: historical.classifications.filter(
			(record) => record.classification === "explicitly-closed",
		).length,
		rejectedIncompatible: historical.classifications.filter(
			(record) => record.classification === "rejected-incompatible",
		).length,
	};
	return {
		blockers,
		classifications: historical.classifications,
		ready: blockers.length === 0,
		summary,
		version: 1,
	};
}
