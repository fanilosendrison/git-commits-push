import {
	cutoverLegacyGlobalRuns,
	inspectLegacyGlobalRunCutover,
} from "../src/modules/reconciliation/legacy-global-run-cutover.ts";
import { resolveLegacyGlobalRunCutoverPaths } from "../src/modules/reconciliation/legacy-global-run-paths.ts";
import {
	resolveApplicationStateDirectory,
	resolveReconcilerStateDirectory,
} from "../src/modules/reconciliation/reconciler-paths.ts";
import { inspectReconciliationPreflightState } from "../src/modules/reconciliation/reconciler-preflight.ts";
import {
	acquireStateCutoverLock,
	releaseStateCutoverLock,
} from "../src/modules/reconciliation/state-cutover-lock.ts";

const APPLY_FLAG = "--apply";
const CONFIRMATION_FLAG = "--confirm-no-live-execution";

function parseArguments(argumentsList) {
	const allowed = new Set([APPLY_FLAG, CONFIRMATION_FLAG]);
	for (const argument of argumentsList) {
		if (!allowed.has(argument)) {
			throw new Error(`Unknown legacy-global cutover argument: ${argument}`);
		}
	}
	if (new Set(argumentsList).size !== argumentsList.length) {
		throw new Error("Legacy-global cutover flags may be provided only once.");
	}
	const apply = argumentsList.includes(APPLY_FLAG);
	const confirmedNoLiveExecution = argumentsList.includes(CONFIRMATION_FLAG);
	if (!apply && confirmedNoLiveExecution) {
		throw new Error(`${CONFIRMATION_FLAG} is valid only with ${APPLY_FLAG}.`);
	}
	if (apply && !confirmedNoLiveExecution) {
		throw new Error(
			`${APPLY_FLAG} requires ${CONFIRMATION_FLAG} after externally proving every historical execution is dead.`,
		);
	}
	return { apply, confirmedNoLiveExecution };
}

function assertReconcilerIdle(environment) {
	const blockers = inspectReconciliationPreflightState(
		resolveReconcilerStateDirectory(environment),
		Date.now(),
	);
	if (blockers.length > 0) {
		throw new Error(
			`Reconciliation preflight blocks legacy-global cutover: ${blockers.map(({ kind, detail }) => `${kind}: ${detail}`).join("; ")}`,
		);
	}
}

function output(paths, report, mode) {
	process.stdout.write(
		`${JSON.stringify({ mode, paths, report, version: 1 }, null, 2)}\n`,
	);
}

try {
	const argumentsState = parseArguments(process.argv.slice(2));
	const paths = resolveLegacyGlobalRunCutoverPaths(process.env);
	if (!argumentsState.apply) {
		const report = inspectLegacyGlobalRunCutover(paths);
		output(paths, report, "inspect");
		process.exitCode = report.ready ? 0 : 1;
	} else {
		if (process.env.ORDER_STATE_DIR !== undefined) {
			throw new Error(
				"Legacy-global cutover refuses ORDER_STATE_DIR because overridden launchers do not share the default state cutover lock.",
			);
		}
		const applicationStateDirectory = resolveApplicationStateDirectory(
			process.env,
		);
		const lockPath = acquireStateCutoverLock(applicationStateDirectory);
		try {
			assertReconcilerIdle(process.env);
			const report = cutoverLegacyGlobalRuns({
				...paths,
				confirmedNoLiveExecution: argumentsState.confirmedNoLiveExecution,
				revokedAt: new Date().toISOString(),
			});
			output(paths, report, "apply");
		} finally {
			releaseStateCutoverLock(lockPath);
		}
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`Legacy-global cutover failed: ${message}\n`);
	process.exitCode = 2;
}
