/**
 * src/types.ts — Type contracts shared between production code and tests.
 * This file must reflect the schemas defined in NIB-S §3 (Data Structures).
 *
 * STATUS: STUB — production implementation pending (RED phase).
 */

export interface Settings {
	searchPaths: string[];
	provider: string;
	model: string;
	temperature: number;
	systemPromptPath: string;
	autoPush: boolean;
	skipTests: boolean;
}

export interface RepositoryInfo {
	id: string;
	path: string;
}

export interface CommitMessage {
	type: string;
	scope?: string | undefined;
	description: string;
	body?: string | undefined;
	isBreaking: boolean;
}

/**
 * A single commit plan: one commit message + the list of files to stage for it.
 * Multiple CommitPlans per repo enable file-level commit splitting.
 */
export interface CommitPlan {
	commit: CommitMessage;
	files: string[]; // relative paths from the repo root
}

/**
 * Payload embedded as JSON string inside an AgentBatchDelegationRequest job's `prompt` field.
 * See: NIB-S §3 > CommitJobPayload, DC-TURNLOCK §4.
 */
export interface CommitJobPayload {
	repository: string;
	diff: string;
	diffHash: string;
	provider: string;
	model: string;
	temperature: number;
	systemPrompt: string;
	feedback?: {
		previous_commit: string;
		validation_errors: string[];
	};
}

/** Written by the Pi wrapper to each job's resultPath on success */
export interface CommitJobResultSuccess {
	success: true;
	id: string;
	commits: CommitPlan[];
}

/** Written by the Pi wrapper to each job's resultPath on failure */
export interface CommitJobResultError {
	success: false;
	id: string;
	error: string;
}

export type CommitJobResult = CommitJobResultSuccess | CommitJobResultError;

export interface RepoState {
	repository: string;
	status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";
	diffHash?: string | undefined;
	commits?: CommitPlan[] | undefined;
	error?: string | undefined;
	attempts?: number | undefined;
}

export interface GlobalState {
	repos: Record<string, RepoState>;
}
