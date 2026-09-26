import * as fs from "node:fs";
import * as path from "node:path";
import { GCP_TURNLOCK_ORCHESTRATOR_NAME } from "./legacy-global-run-paths.ts";
import { inspectTurnlockRunDirectory } from "./turnlock-run-state-inspection.ts";

export const LEGACY_GLOBAL_REVOCATION_KIND =
	"git-commits-push-legacy-global-run-revocation" as const;

interface RevocationTombstone {
	readonly kind: typeof LEGACY_GLOBAL_REVOCATION_KIND;
	readonly orchestratorName: typeof GCP_TURNLOCK_ORCHESTRATOR_NAME;
	readonly revokedAt: string;
	readonly runId: string;
	readonly version: 1;
}

export interface RevokeLegacyGlobalRunOptions {
	readonly quarantineDirectory: string;
	readonly revokedAt: string;
	readonly runId: string;
	readonly runsDirectory: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fsyncDirectory(directoryPath: string): void {
	const descriptor = fs.openSync(directoryPath, "r");
	try {
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
}

/** Parse and validate one physical legacy-global revocation tombstone. */
export function parseLegacyGlobalRevocationTombstone(
	filePath: string,
	runId: string,
): void {
	const stats = fs.lstatSync(filePath);
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error("revocation tombstone is not a physical regular file");
	}
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
	} catch {
		throw new Error("revocation tombstone is not valid JSON");
	}
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		value.kind !== LEGACY_GLOBAL_REVOCATION_KIND ||
		value.orchestratorName !== GCP_TURNLOCK_ORCHESTRATOR_NAME ||
		value.runId !== runId ||
		typeof value.revokedAt !== "string" ||
		new Date(value.revokedAt).toISOString() !== value.revokedAt
	) {
		throw new Error("revocation tombstone is invalid");
	}
}

function writeTombstone(
	canonicalPath: string,
	runId: string,
	revokedAt: string,
): void {
	const tombstone: RevocationTombstone = {
		kind: LEGACY_GLOBAL_REVOCATION_KIND,
		orchestratorName: GCP_TURNLOCK_ORCHESTRATOR_NAME,
		revokedAt,
		runId,
		version: 1,
	};
	const descriptor = fs.openSync(canonicalPath, "wx", 0o600);
	try {
		fs.writeFileSync(descriptor, `${JSON.stringify(tombstone)}\n`, "utf8");
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
	fsyncDirectory(path.dirname(canonicalPath));
}

/** Return whether a path contains one valid revocation tombstone. */
export function isLegacyGlobalRevocationTombstone(
	filePath: string,
	runId: string,
): boolean {
	try {
		parseLegacyGlobalRevocationTombstone(filePath, runId);
		return true;
	} catch {
		return false;
	}
}

/** Move one revalidated global run and occupy its canonical path durably. */
export function revokeLegacyGlobalRun(
	options: RevokeLegacyGlobalRunOptions,
): void {
	const canonicalPath = path.join(options.runsDirectory, options.runId);
	const quarantinePath = path.join(options.quarantineDirectory, options.runId);
	if (fs.existsSync(canonicalPath)) {
		const stats = fs.lstatSync(canonicalPath);
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw new Error(
				`Canonical run path changed before revocation: ${options.runId}`,
			);
		}
		if (fs.existsSync(quarantinePath)) {
			throw new Error(
				`Quarantine path changed before revocation: ${options.runId}`,
			);
		}
		const revalidated = inspectTurnlockRunDirectory(
			canonicalPath,
			options.runId,
		);
		if (revalidated.scope !== "global" || revalidated.ownershipHeld) {
			throw new Error(
				`Run changed before legacy global revocation: ${options.runId}`,
			);
		}
		try {
			fs.renameSync(canonicalPath, quarantinePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EXDEV") {
				throw new Error(
					"Legacy global cutover requires quarantine on the same filesystem.",
					{ cause: error },
				);
			}
			throw error;
		}
		fsyncDirectory(options.runsDirectory);
		fsyncDirectory(options.quarantineDirectory);
	}
	if (!fs.existsSync(canonicalPath)) {
		const quarantined = inspectTurnlockRunDirectory(
			quarantinePath,
			options.runId,
		);
		if (quarantined.scope !== "global" || quarantined.ownershipHeld) {
			throw new Error(
				`Quarantined run failed revocation verification: ${options.runId}`,
			);
		}
		writeTombstone(canonicalPath, options.runId, options.revokedAt);
	}
}
