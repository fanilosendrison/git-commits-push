import {
	type InvocationRequest,
	parseInvocationArguments,
} from "../invocation/targeted-arguments.ts";
import type { ReconciliationInvocationMode } from "./reconciler-db.ts";

const FRESH_INVOCATION_RECONCILIATION_MODES: Readonly<
	Record<InvocationRequest["kind"], ReconciliationInvocationMode>
> = Object.freeze({
	worktree: "targeted",
	targeted: "targeted",
	"targeted-create": "targeted",
});

/** Pure pre-admission classification: every fresh exact request is non-coalescing. */
export function classifyPublicInvocationMode(
	args: readonly string[],
): ReconciliationInvocationMode {
	return FRESH_INVOCATION_RECONCILIATION_MODES[
		parseInvocationArguments(args).request.kind
	];
}
