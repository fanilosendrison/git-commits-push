/**
 * Detection and exact migration of legacy file-queue artifacts.
 *
 * Legacy state is inspected before SQLite admission, then verified again before
 * cleanup. Only the exact regular-file inodes and bytes originally inspected
 * may be removed.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const LEGACY_LOCK_FILE_NAME = "running.lock";
export const LEGACY_QUEUE_LOCK_STALE_AFTER_MS = 40_000;

const LEGACY_ORDER_FILE_PATTERN =
	/^order-\d+-[A-Za-z0-9][A-Za-z0-9._-]*\.(json|flag)$/;
const LEGACY_ORDER_CANDIDATE_PATTERN = /^order-/;

export type LegacyLockClassification = "none" | "live" | "stale" | "malformed";

export interface LegacyArtifactEvidence {
	readonly path: string;
	readonly device: number;
	readonly inode: number;
	readonly size: number;
	readonly modifiedAtEpochMs: number;
	readonly sha256: string;
}

export interface LegacyQueueInspection {
	readonly lock: LegacyLockClassification;
	readonly lockEvidence: LegacyArtifactEvidence | null;
	readonly orderArtifactPaths: readonly string[];
	readonly orderArtifactEvidence: readonly LegacyArtifactEvidence[];
}

export function isLegacyQueueArtifactName(fileName: string): boolean {
	return (
		fileName === LEGACY_LOCK_FILE_NAME ||
		LEGACY_ORDER_FILE_PATTERN.test(fileName)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRegularFile(filePath: string): {
	readonly contents: Buffer;
	readonly evidence: LegacyArtifactEvidence;
} {
	const descriptor = fs.openSync(
		filePath,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
	);
	try {
		const before = fs.fstatSync(descriptor);
		if (!before.isFile()) throw new Error("artifact is not a regular file");
		const contents = fs.readFileSync(descriptor);
		const after = fs.fstatSync(descriptor);
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			contents.byteLength !== after.size
		) {
			throw new Error("artifact changed while it was being inspected");
		}
		return {
			contents,
			evidence: {
				path: filePath,
				device: after.dev,
				inode: after.ino,
				size: after.size,
				modifiedAtEpochMs: after.mtimeMs,
				sha256: createHash("sha256").update(contents).digest("hex"),
			},
		};
	} finally {
		fs.closeSync(descriptor);
	}
}

function readLegacyOrderEvidence(filePath: string): LegacyArtifactEvidence {
	try {
		if (!LEGACY_ORDER_FILE_PATTERN.test(path.basename(filePath))) {
			throw new Error("artifact name does not match the legacy queue format");
		}
		const artifact = readRegularFile(filePath);
		if (path.extname(filePath) === ".json") {
			const parsed: unknown = JSON.parse(artifact.contents.toString("utf8"));
			if (!isRecord(parsed)) throw new Error("JSON artifact is not an object");
		}
		return artifact.evidence;
	} catch (error) {
		throw new Error(
			`Legacy order artifact is malformed or unreadable: ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

function classifyLegacyLock(
	lockPath: string,
	nowEpochMs: number,
): {
	readonly classification: LegacyLockClassification;
	readonly evidence: LegacyArtifactEvidence | null;
} {
	let lock: ReturnType<typeof readRegularFile>;
	try {
		lock = readRegularFile(lockPath);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { classification: "none", evidence: null }
			: { classification: "malformed", evidence: null };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(lock.contents.toString("utf8"));
	} catch {
		return { classification: "malformed", evidence: lock.evidence };
	}
	if (
		!isRecord(parsed) ||
		typeof parsed.runId !== "string" ||
		typeof parsed.callerName !== "string" ||
		typeof parsed.timestamp !== "number" ||
		!Number.isFinite(parsed.timestamp)
	) {
		return { classification: "malformed", evidence: lock.evidence };
	}
	return {
		classification:
			nowEpochMs - lock.evidence.modifiedAtEpochMs <=
			LEGACY_QUEUE_LOCK_STALE_AFTER_MS
				? "live"
				: "stale",
		evidence: lock.evidence,
	};
}

/** Inspect legacy queue artifacts without deleting or creating anything. */
export function inspectLegacyQueueState(
	stateDirectory: string,
	nowEpochMs: number = Date.now(),
): LegacyQueueInspection {
	let entries: string[];
	try {
		const stateDirectoryStat = fs.statSync(stateDirectory, {
			throwIfNoEntry: false,
		});
		if (!stateDirectoryStat) {
			return {
				lock: "none",
				lockEvidence: null,
				orderArtifactPaths: [],
				orderArtifactEvidence: [],
			};
		}
		if (!stateDirectoryStat.isDirectory()) {
			throw new Error("configured state path is not a directory");
		}
		entries = fs.readdirSync(stateDirectory);
	} catch (error) {
		throw new Error(
			`Reconciliation state directory is unreadable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const lockResult = entries.includes(LEGACY_LOCK_FILE_NAME)
		? classifyLegacyLock(
				path.join(stateDirectory, LEGACY_LOCK_FILE_NAME),
				nowEpochMs,
			)
		: { classification: "none" as const, evidence: null };
	const orderArtifactEvidence = entries
		.filter((entryName) => LEGACY_ORDER_CANDIDATE_PATTERN.test(entryName))
		.map((entryName) =>
			readLegacyOrderEvidence(path.join(stateDirectory, entryName)),
		)
		.sort((left, right) => left.path.localeCompare(right.path));
	return {
		lock: lockResult.classification,
		lockEvidence: lockResult.evidence,
		orderArtifactPaths: orderArtifactEvidence.map((entry) => entry.path),
		orderArtifactEvidence,
	};
}

function evidenceMatches(
	left: LegacyArtifactEvidence | null,
	right: LegacyArtifactEvidence | null,
): boolean {
	if (left === null || right === null) return left === right;
	return (
		left.path === right.path &&
		left.device === right.device &&
		left.inode === right.inode &&
		left.size === right.size &&
		left.modifiedAtEpochMs === right.modifiedAtEpochMs &&
		left.sha256 === right.sha256
	);
}

function inspectionIsCompatibleForCleanup(
	expected: LegacyQueueInspection,
	current: LegacyQueueInspection,
): boolean {
	const expectedEvidence = [
		...(expected.lockEvidence ? [expected.lockEvidence] : []),
		...expected.orderArtifactEvidence,
	];
	const currentEvidence = [
		...(current.lockEvidence ? [current.lockEvidence] : []),
		...current.orderArtifactEvidence,
	];
	return currentEvidence.every((entry) =>
		expectedEvidence.some((candidate) => evidenceMatches(candidate, entry)),
	);
}

function archiveExactArtifact(evidence: LegacyArtifactEvidence): void {
	const archivePath = path.join(
		path.dirname(evidence.path),
		`.gcp-migrated-${path.basename(evidence.path)}-${randomUUID()}`,
	);
	fs.renameSync(evidence.path, archivePath);
	let movedEvidence: LegacyArtifactEvidence;
	try {
		movedEvidence = readRegularFile(archivePath).evidence;
	} catch (error) {
		throw new Error("moved legacy artifact cannot be verified", {
			cause: error,
		});
	}
	const expectedAtArchive = { ...evidence, path: archivePath };
	if (!evidenceMatches(expectedAtArchive, movedEvidence)) {
		// Never restore by pathname: a concurrent legacy writer may now own it.
		// The unique archive preserves whichever inode was moved for inspection.
		throw new Error("legacy artifact changed before archival");
	}
}

/**
 * Revalidate and archive only exact artifacts inspected before admission.
 * Missing evidence was already migrated by another owner and is safe. Any new,
 * replaced, or mutated artifact fails closed and remains preserved.
 */
export function deleteLegacyQueueArtifacts(
	stateDirectory: string,
	expected: LegacyQueueInspection,
): void {
	const current = inspectLegacyQueueState(stateDirectory);
	if (!inspectionIsCompatibleForCleanup(expected, current)) {
		throw new Error(
			"legacy queue state changed after reconciliation admission",
		);
	}
	for (const evidence of current.orderArtifactEvidence) {
		archiveExactArtifact(evidence);
	}
	if (current.lockEvidence) archiveExactArtifact(current.lockEvidence);
	const remaining = inspectLegacyQueueState(stateDirectory);
	if (remaining.lock !== "none" || remaining.orderArtifactPaths.length > 0) {
		throw new Error("legacy queue state changed during reconciliation cleanup");
	}
}
