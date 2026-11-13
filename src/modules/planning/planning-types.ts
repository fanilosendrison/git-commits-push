import type {
	CommitPlan,
	CommittedSha,
	Feedback,
	FeedbackError,
	ValidatedSourceWitness,
} from "../../types.ts";

interface CommitJobPayloadBase {
	planningBudget?:
		| import("../llm/planning-attempt-budget.ts").PlanningBudgetState
		| undefined;
	planningSource?: PlanningSource | undefined;
	repository: string;
	diffHash: string;
	provider: string;
	model: string;
	temperature: number;
	systemPrompt: string;
	thinking?: boolean | undefined;
	agent?: string | undefined;
}

export interface CommitPlanningPayload extends CommitJobPayloadBase {
	mode?: "plan" | undefined;
	/** Complete remaining validation input; never a silently truncated prefix. */
	diff: string;
	feedback?: Feedback | undefined;
}

export interface CommitMessageRepairPayload extends CommitJobPayloadBase {
	mode: "repair-commit-messages";
	rejectedPlans: CommitPlan[];
	validationErrors: FeedbackError[];
}

export type CommitJobPayload =
	| CommitPlanningPayload
	| CommitMessageRepairPayload;

export interface PlanningSource {
	readonly witness: ValidatedSourceWitness;
	readonly committedShas?: readonly CommittedSha[] | undefined;
	readonly publisherIndexTreeSha?: string | undefined;
	readonly creation: boolean;
	readonly maxDiffChars: number;
}

export interface PlanningPathInput {
	readonly path: string;
	readonly patch: string;
}

export interface PlanningPartition {
	readonly paths: readonly string[];
	readonly diff: string;
}
