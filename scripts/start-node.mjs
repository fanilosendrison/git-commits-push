/**
 * scripts/start-node.mjs — Public git-commits-push launcher and GLOBAL RECONCILER.
 *
 * One public invocation means: "the world may have changed; reconcile global
 * Git state again". The launcher:
 *
 *   1. inspects legacy queue artifacts (fail closed on a live legacy worker);
 *   2. atomically registers the reconciliation request in SQLite BEFORE any
 *      build (coalesced callers exit 0 here, before touching dist);
 *   3. becomes the stable reconciliation owner for its whole child lifecycle;
 *   4. builds ONCE;
 *   5. runs fresh compiled-supervisor passes until every requested generation
 *      is completed, then releases ownership and exits.
 *
 * Turnlock owns HOW one pass executes; this launcher owns WHO runs and
 * WHETHER another global pass is needed.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildOnce } from "./start-node-internals/build-once.mjs";
import { createLauncherCancellation } from "./start-node-internals/launcher-cancellation.mjs";
import { runSupervisorPass } from "./start-node-internals/supervisor-pass.mjs";

const HEARTBEAT_INTERVAL_MS = 10_000;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");
const repositoryDirectory = path.resolve(skillDirectory, "../..");
const nodeRuntimeDirectory = path.join(
	repositoryDirectory,
	"packages",
	"node-runtime",
);
// ── Reconciliation coordination (source modules — must run BEFORE build) ────
const reconcilerDb = await import(
	pathToFileURL(
		path.join(
			skillDirectory,
			"src",
			"modules",
			"reconciliation",
			"reconciler-db.ts",
		),
	).href
);
const reconciler = await import(
	pathToFileURL(
		path.join(
			skillDirectory,
			"src",
			"modules",
			"reconciliation",
			"reconciler.ts",
		),
	).href
);
const legacyQueue = await import(
	pathToFileURL(
		path.join(
			skillDirectory,
			"src",
			"modules",
			"reconciliation",
			"legacy-queue-state.ts",
		),
	).href
);
const requestIdentityModule = await import(
	pathToFileURL(
		path.join(
			skillDirectory,
			"src",
			"modules",
			"orders",
			"request-identity.ts",
		),
	).href
);
const statsLoggerModule = await import(
	pathToFileURL(
		path.join(skillDirectory, "src", "modules", "telemetry", "stats-logger.ts"),
	).href
);

const identity = requestIdentityModule.resolveRequestIdentity();
const createSkillStatsLog = statsLoggerModule.createSkillStatsLog;

function logTelemetry(method, params) {
	try {
		createSkillStatsLog()[method](params);
	} catch {
		// Telemetry must never block or crash reconciliation.
	}
}

function writeCoalescedMessage(generation) {
	process.stdout.write(
		`Reconciliation requested (generation ${generation}).\n` +
			"Another git-commits-push worker is active.\n" +
			"This terminal can exit; the active worker will perform another global rescan before becoming idle.\n",
	);
}

function writeLiveLegacyWorkerMessage() {
	process.stderr.write(
		"git-commits-push: a legacy queue worker (running.lock) appears active.\n" +
			"Refusing to start a competing reconciler. Wait for the legacy worker to finish, then run again;\n" +
			"or remove the lock manually after confirming that no legacy worker is running.\n",
	);
}

function writeMalformedLegacyLockMessage() {
	process.stderr.write(
		"git-commits-push: legacy queue lock (running.lock) is malformed or unreadable.\n" +
			"Refusing reconciliation because legacy worker liveness cannot be established.\n" +
			"Preserve and inspect the lock before removing it manually.\n",
	);
}

function failClosed(message) {
	process.stderr.write(`git-commits-push: ${message}\n`);
	process.exitCode = 2;
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

// ── 1. Legacy queue inspection (before any SQLite write) ───────────────────
const stateDirectory = reconcilerDb.resolveReconcilerStateDirectory(
	process.env,
	skillDirectory,
);
let legacyInspection;
try {
	legacyInspection = legacyQueue.inspectLegacyQueueState(stateDirectory);
} catch (error) {
	failClosed(
		`reconciliation state directory is unreadable: ${errorMessage(error)}`,
	);
	process.exit(2);
}
if (legacyInspection.lock === "live") {
	writeLiveLegacyWorkerMessage();
	process.exit(2);
}
if (legacyInspection.lock === "malformed") {
	writeMalformedLegacyLockMessage();
	process.exit(2);
}

// ── 2. Open the durable coordinator state (fail closed) ────────────────────
fs.mkdirSync(stateDirectory, { recursive: true });
let db;
try {
	db = reconcilerDb.openReconcilerDb(
		reconcilerDb.resolveReconcilerDbPath(stateDirectory),
	);
} catch (error) {
	if (
		error instanceof reconcilerDb.ReconcilerOpenError ||
		error instanceof reconcilerDb.ReconcilerInvariantError
	) {
		failClosed(errorMessage(error));
		process.exit(2);
	}
	throw error;
}

// ── 3. Atomic admission BEFORE BUILD ────────────────────────────────────────
const ownerToken = randomBytes(16).toString("hex");
const ownerProcessIdentity =
	reconciler.establishCurrentProcessIdentity(ownerToken);
if (!ownerProcessIdentity) {
	failClosed("cannot read the launcher process start identity");
	db.close();
	process.exit(2);
}
let ownerActive = false;
const cancellation = createLauncherCancellation();

let registration;
try {
	registration = reconciler.registerReconciliationRequest(db, {
		token: ownerToken,
		pid: process.pid,
		bootEpochMs: reconciler.currentBootEpochMs(),
		processIdentity: ownerProcessIdentity,
		callerName: identity.callerName,
		originAgent: identity.originAgent,
		originSessionId: identity.originSessionId,
		nowEpochMs: Date.now(),
	});
} catch (error) {
	failClosed(`reconciliation admission failed: ${errorMessage(error)}`);
	db.close();
	process.exit(2);
}

ownerActive = registration.kind === "OWNER";
await new Promise((resolve) => setImmediate(resolve));
if (cancellation.interruptedSignal !== null) {
	if (ownerActive) {
		try {
			reconciler.releaseReconciliationOwnership(db, {
				token: ownerToken,
				pid: process.pid,
			});
		} catch {
			// Best-effort release before preserving signal termination.
		}
	}
	cancellation.removeSignalHandlers();
	db.close();
	process.kill(process.pid, cancellation.interruptedSignal);
}

logTelemetry("logReconciliationRequested", {
	generation: registration.generation,
	outcome: registration.kind === "OWNER" ? "owner" : "coalesced",
	callerName: identity.callerName,
	originAgent: identity.originAgent,
	originSessionId: identity.originSessionId,
	recovered: registration.kind === "OWNER" ? registration.recovered : undefined,
});

if (registration.kind === "COALESCED") {
	logTelemetry("logReconciliationCoalesced", {
		generation: registration.generation,
		ownerPid: registration.ownerPid,
		ownerCallerName: registration.ownerCallerName,
	});
	// Only the owner migrates legacy evidence; concurrent cleanup would race it.
	writeCoalescedMessage(registration.generation);
	db.close();
	process.exit(0);
}

// ── 4. Owner lifecycle cancellation covers migration, build, and passes ────
function releaseOwnershipBestEffort() {
	if (!ownerActive) return;
	try {
		reconciler.releaseReconciliationOwnership(db, {
			token: ownerToken,
			pid: process.pid,
		});
	} catch {
		// Best-effort release; fencing still prevents stale finalization.
	}
}

function closeOwnerResources(heartbeat) {
	ownerActive = false;
	if (heartbeat) clearInterval(heartbeat);
	cancellation.removeSignalHandlers();
	db.close();
}

process.on("uncaughtException", (error) => {
	process.stderr.write(
		`git-commits-push launcher crashed: ${errorMessage(error)}\n`,
	);
	releaseOwnershipBestEffort();
	try {
		db.close();
	} catch {
		// Connection may already be unusable.
	}
	process.exit(1);
});

try {
	legacyQueue.deleteLegacyQueueArtifacts(stateDirectory, legacyInspection);
} catch (error) {
	releaseOwnershipBestEffort();
	closeOwnerResources(null);
	failClosed(`legacy queue migration failed: ${errorMessage(error)}`);
	process.exit(2);
}
if (registration.recovered) {
	process.stderr.write(
		`git-commits-push: recovered reconciliation state from a previous owner ` +
			`(pid ${registration.previousOwnerPid}). Performing a fresh global rescan.\n`,
	);
	logTelemetry("logReconciliationRecovered", {
		generation: registration.generation,
		previousOwnerPid: registration.previousOwnerPid,
	});
}

const heartbeat = setInterval(() => {
	try {
		const retained = reconciler.heartbeatReconciler(db, {
			token: ownerToken,
			pid: process.pid,
			nowEpochMs: Date.now(),
		});
		if (!retained) {
			cancellation.abortForOwnershipFailure(
				"reconciliation ownership was lost; active work was terminated",
			);
		}
	} catch (error) {
		cancellation.abortForOwnershipFailure(
			`reconciliation heartbeat failed: ${errorMessage(error)}`,
		);
	}
}, HEARTBEAT_INTERVAL_MS);

function terminateAfterCancellation() {
	releaseOwnershipBestEffort();
	closeOwnerResources(heartbeat);
	if (cancellation.interruptedSignal !== null) {
		process.kill(process.pid, cancellation.interruptedSignal);
	}
	failClosed(
		cancellation.ownershipFailure ?? "reconciliation ownership was lost",
	);
	process.exit(2);
}

// ── 5. Build ONCE (only the owner may touch dist) ──────────────────────────
const build = await buildOnce({
	nodeRuntimeDirectory,
	scriptDirectory,
	skillDirectory,
	abortSignal: cancellation.signal,
});
if (cancellation.signal.aborted) terminateAfterCancellation();
if (build.exitCode !== 0) {
	const finish = reconciler.finishReconciliationPass(db, {
		token: ownerToken,
		pid: process.pid,
		generation: registration.generation,
		success: false,
		nowEpochMs: Date.now(),
	});
	if (finish.decision === "CONTINUE") releaseOwnershipBestEffort();
	closeOwnerResources(heartbeat);
	process.exitCode = build.exitCode ?? 1;
	process.exit();
}

// ── 6. Pass loop: fresh compiled supervisor per generation ─────────────────
let generation = registration.generation;
while (true) {
	logTelemetry("logReconciliationPassStarted", { generation });
	const pass = await runSupervisorPass({
		nodeRuntimeDirectory,
		skillDirectory,
		passthroughArguments: process.argv.slice(2),
		abortSignal: cancellation.signal,
	});
	if (cancellation.signal.aborted) terminateAfterCancellation();

	const success =
		pass.spawnError === null && pass.signal === null && pass.exitCode === 0;
	const finish = reconciler.finishReconciliationPass(db, {
		token: ownerToken,
		pid: process.pid,
		generation,
		success,
		nowEpochMs: Date.now(),
	});
	logTelemetry("logReconciliationPassFinished", {
		generation,
		exitCode: pass.exitCode ?? 1,
		success,
		decision: finish.decision,
	});

	if (finish.decision === "CONTINUE") {
		generation = finish.generation;
		continue;
	}
	if (finish.decision === "STOP_SUCCESS") {
		logTelemetry("logReconciliationIdle", {
			generation: finish.completedGeneration,
		});
	}
	process.exitCode = success ? 0 : (pass.exitCode ?? 1);
	break;
}

closeOwnerResources(heartbeat);
