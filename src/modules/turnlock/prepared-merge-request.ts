import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "turnlock";
import { z } from "zod";
import { stateSchema } from "../../config/state-schema.ts";
import type { GlobalState, RepoState } from "../../types.ts";
import { sanitizeSensitiveDiagnostic } from "../core/sensitive-diagnostic-sanitizer.ts";
import { assertCommitCompletion } from "../git/commit-completion.ts";
import {
	establishPreparedMergeCommit,
	publishEstablishedPreparedMerge,
} from "../git/prepared-merge-publisher.ts";
import { GCP_TURNLOCK_ORCHESTRATOR_NAME } from "../reconciliation/legacy-global-run-paths.ts";

export const PREPARED_MERGE_REQUEST_TYPES = {
	commit: "git.prepared-merge.commit",
	publish: "git.prepared-merge.publish",
	report: "git.prepared-merge.report",
} as const;
export type PreparedMergeRequestKind =
	keyof typeof PREPARED_MERGE_REQUEST_TYPES;
export function preparedMergeRequestPayload(state: GlobalState): JsonValue {
	return JSON.parse(JSON.stringify(stateSchema.parse(state))) as JsonValue;
}

const manifestSchema = z
	.object({
		manifestVersion: z.literal(1),
		kind: z.literal("external-request"),
		requestId: z.string(),
		runId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
		orchestratorName: z.literal(GCP_TURNLOCK_ORCHESTRATOR_NAME),
		phase: z.string(),
		resumeAt: z.string(),
		label: z.string(),
		requestType: z.enum([
			PREPARED_MERGE_REQUEST_TYPES.commit,
			PREPARED_MERGE_REQUEST_TYPES.publish,
			PREPARED_MERGE_REQUEST_TYPES.report,
		]),
		payload: stateSchema,
		emittedAt: z.string(),
		emittedAtEpochMs: z.number().finite(),
		resultPath: z.string(),
	})
	.strict();
const resolutionSchema = z.object({ repo: z.unknown() }).strict();

/** Validate a returned opaque resolution against the original source/target, never recapture authority. */
export function consumePreparedMergeResolution(
	original: GlobalState,
	resolution: unknown,
): GlobalState {
	const { repo } = resolutionSchema.parse(resolution);
	const entries = Object.entries(original.repos);
	const entry = entries[0];
	if (
		entries.length !== 1 ||
		!entry ||
		original.invocationScope.kind !== "prepared-merge"
	)
		throw new Error("Missing exact prepared request authority.");
	const next = stateSchema.parse({
		invocationScope: original.invocationScope,
		repos: { [entry[0]]: repo },
	});
	const actual = next.repos[entry[0]];
	if (
		!actual ||
		!isDeepStrictEqual(actual.validatedSource, entry[1].validatedSource) ||
		!isDeepStrictEqual(
			actual.explicitPushTargetSnapshot,
			entry[1].explicitPushTargetSnapshot,
		)
	)
		throw new Error(
			"External resolution attempted to replace frozen prepared source or target.",
		);
	return next;
}

function regularBytes(file: string): Buffer {
	const stat = lstatSync(file);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error("Prepared request requires regular immutable artifacts.");
	return readFileSync(file);
}

/** Confront the manifest with authoritative SQLite state and its artifact digest before any Git effect. */
function authorizeRequest(manifestPath: string, raw: string) {
	const manifest = manifestSchema.parse(JSON.parse(raw));
	const root =
		process.env.TURNLOCK_RUN_DIR_ROOT ??
		path.join(os.homedir(), ".turnlock", "runs");
	const run = path.join(root, GCP_TURNLOCK_ORCHESTRATOR_NAME, manifest.runId);
	const kind = (
		Object.keys(PREPARED_MERGE_REQUEST_TYPES) as PreparedMergeRequestKind[]
	).find((key) => PREPARED_MERGE_REQUEST_TYPES[key] === manifest.requestType);
	if (
		!kind ||
		manifest.label !== `prepared-merge-${kind}` ||
		manifest.requestId !== `${manifest.runId}/${manifest.label}` ||
		path.resolve(manifestPath) !==
			path.join(run, "external-requests", `${manifest.label}.json`) ||
		realpathSync(run) !== run ||
		manifest.resultPath !==
			path.join(run, "external-results", `${manifest.label}.json`)
	)
		throw new Error("Prepared request identity/path mismatch.");
	const bytes = regularBytes(manifestPath);
	if (bytes.toString("utf8") !== raw)
		throw new Error("Prepared manifest changed during admission.");
	const db = new DatabaseSync(path.join(run, "turnlock.sqlite3"), {
		readOnly: true,
	});
	try {
		const row = db
			.prepare(
				"SELECT state_json, state_digest FROM run_state WHERE singleton = 1",
			)
			.get() as { state_json: string; state_digest: string } | undefined;
		const owner = db
			.prepare("SELECT ownership_status FROM run_ownership WHERE singleton = 1")
			.get() as { ownership_status: string } | undefined;
		if (
			!row ||
			owner?.ownership_status !== "FREE" ||
			row.state_digest !==
				`sha256:${createHash("sha256").update(row.state_json).digest("hex")}`
		)
			throw new Error(
				"Prepared request has no free, digest-verified Turnlock authority.",
			);
		const authority = z
			.object({
				runId: z.literal(manifest.runId),
				orchestratorName: z.literal(GCP_TURNLOCK_ORCHESTRATOR_NAME),
				data: stateSchema,
				pendingExternalRequest: z.object({
					requestId: z.literal(manifest.requestId),
					label: z.literal(manifest.label),
					requestType: z.literal(manifest.requestType),
					resumeAt: z.literal(manifest.resumeAt),
					resultPath: z.literal(manifest.resultPath),
					manifestArtifact: z.object({
						kind: z.literal("external-request-manifest"),
						digestAlgorithm: z.literal("sha256"),
						digest: z.string(),
						sizeBytes: z.number(),
					}),
				}),
			})
			.parse(JSON.parse(row.state_json));
		if (
			authority.pendingExternalRequest.manifestArtifact.digest !==
				`sha256:${createHash("sha256").update(bytes).digest("hex")}` ||
			authority.pendingExternalRequest.manifestArtifact.sizeBytes !==
				bytes.length ||
			!isDeepStrictEqual(authority.data, manifest.payload) ||
			authority.data.invocationScope.kind !== "prepared-merge" ||
			Object.keys(authority.data.repos).length !== 1
		)
			throw new Error(
				"Prepared request is not the current exact durable operation.",
			);
		return { manifest, kind, state: authority.data };
	} finally {
		db.close();
	}
}

function writeResolution(file: string, value: unknown): void {
	const directory = path.dirname(file);
	mkdirSync(directory, { recursive: true });
	if (
		!lstatSync(directory).isDirectory() ||
		lstatSync(directory).isSymbolicLink()
	)
		throw new Error("External result directory must be physical.");
	const temporary = path.join(directory, `.prepared-${randomUUID()}.json`);
	try {
		writeFileSync(temporary, JSON.stringify(value), {
			flag: "wx",
			mode: 0o600,
		});
		const descriptor = openSync(temporary, "r");
		try {
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		linkSync(temporary, file);
		const parent = openSync(directory, "r");
		try {
			fsyncSync(parent);
		} finally {
			closeSync(parent);
		}
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
	}
}

/** Consumer-owned external effects run only while the existing global execution controller is live. */
export function handlePreparedMergeRequest(
	manifestPath: string,
	raw: string,
): { runId: string; label: string } {
	const { manifest, kind, state } = authorizeRequest(manifestPath, raw);
	const scope = state.invocationScope;
	if (scope.kind !== "prepared-merge")
		throw new Error("Missing prepared authority.");
	const repo = Object.values(state.repos)[0];
	if (!repo) throw new Error("Missing prepared source.");
	if (existsSync(manifest.resultPath)) {
		consumePreparedMergeResolution(
			state,
			JSON.parse(regularBytes(manifest.resultPath).toString("utf8")),
		);
		return manifest;
	}
	let result: RepoState = repo;
	try {
		if (kind === "commit") result = establishPreparedMergeCommit(scope, repo);
		else if (kind === "publish") {
			result = publishEstablishedPreparedMerge(scope, repo);
			assertCommitCompletion(result);
		}
	} catch (error) {
		result = {
			...result,
			status: "FAILED",
			error: sanitizeSensitiveDiagnostic(
				error instanceof Error ? error.message : String(error),
			),
		};
	}
	consumePreparedMergeResolution(state, { repo: result });
	writeResolution(manifest.resultPath, { repo: result });
	return manifest;
}
