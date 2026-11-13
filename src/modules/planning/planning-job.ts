import { createHash } from "node:crypto";
import type { CommitJobPayload, CommitPlan } from "../../types.ts";
import { parseCommitJobResponse } from "../core/commit-job-response.ts";
import {
	COMMIT_MESSAGE_REPAIR_SYSTEM_PROMPT,
	formatCommitMessageRepairPrompt,
} from "../core/commit-message-repair.ts";
import { formatFeedbackBlock } from "../core/feedback-formatter.ts";
import { assertCommitPlanCoverage } from "../git/commit-plan-coverage.ts";
import { assertValidatedSource } from "../git/validated-source.ts";
import { productionContextAuthority } from "../llm/context-admission.ts";
import { authorizeContextExecution } from "../llm/context-execution.ts";
import { ContextOverflowError } from "../llm/context-overflow.ts";
import {
	buildContextRequest,
	type LlmInvocation,
} from "../llm/context-request.ts";
import type { ContextAuthority } from "../llm/context-types.ts";
import type { invokeLlm } from "../llm/llm-invoker.ts";
import { reportPlanResponseRejection } from "../llm/plan-response-policy.ts";
import {
	MAX_PLANNING_CALLS,
	MAX_PLANNING_PARTITIONS,
	PlanningAttemptBudget,
} from "../llm/planning-attempt-budget.ts";
import {
	assertExactPlanningCoverage,
	partitionPlanningPaths,
} from "./exact-partitions.ts";
import { readPlanningPathInputs } from "./planning-source.ts";
import type { PlanningPartition } from "./planning-types.ts";

export function renderPlanningInvocation(
	payload: CommitJobPayload,
	token: string,
	partition?: PlanningPartition,
): LlmInvocation {
	const repair = payload.mode === "repair-commit-messages";
	let userPrompt: string;
	if (repair) userPrompt = formatCommitMessageRepairPrompt(payload);
	else {
		const diff = partition?.diff ?? payload.diff;
		const feedback =
			partition && payload.feedback?.pending_files
				? { ...payload.feedback, pending_files: [...partition.paths] }
				: payload.feedback;
		userPrompt = feedback?.pending_files
			? formatFeedbackBlock(feedback, diff)
			: diff + (feedback ? formatFeedbackBlock(feedback) : "");
		if (partition)
			userPrompt = `AUTHORITATIVE_PARTITION ${JSON.stringify({
				H0: payload.planningSource?.witness.baseHeadSha,
				T: payload.planningSource?.witness.expectedTreeSha,
				fullDiffHash: payload.planningSource?.witness.fullDiffHash,
				paths: partition.paths,
			})}\nCover these literal paths exactly once and no others. History is not path authority.\n${userPrompt}`;
	}
	return {
		provider: payload.provider,
		model: payload.model,
		token,
		temperature: payload.temperature,
		systemPrompt: repair
			? COMMIT_MESSAGE_REPAIR_SYSTEM_PROMPT
			: payload.systemPrompt,
		userPrompt,
		stripJsonFence: true,
		...(payload.thinking === undefined ? {} : { thinking: payload.thinking }),
	};
}

/** One result for the entire repository: partial partition plans never reach Git effects. */
export async function executePlanningJob(
	payload: CommitJobPayload,
	token: string,
	invoke: typeof invokeLlm,
	suppliedAuthority: ContextAuthority = productionContextAuthority,
	budget = new PlanningAttemptBudget(payload.planningBudget),
): Promise<CommitPlan[]> {
	const authority = budget.boundAuthority(suppliedAuthority);
	let calls = budget.snapshot().calls;
	const source = payload.planningSource;
	const call = async (partition?: PlanningPartition): Promise<CommitPlan[]> => {
		for (;;) {
			const invocation = renderPlanningInvocation(payload, token, partition);
			await authorizeContextExecution(
				buildContextRequest(invocation),
				authority,
			);
			if (++calls > MAX_PLANNING_CALLS)
				throw new Error("Planning call budget exhausted");
			const response = await invoke(invocation, undefined, budget);
			try {
				return parseCommitJobResponse(payload, response);
			} catch (error) {
				const willRepeat = budget.repeatMalformed();
				const failure = reportPlanResponseRejection(
					error,
					calls,
					willRepeat,
					invocation.stripJsonFence ?? true,
				);
				if (!willRepeat) throw failure;
			}
		}
	};
	if (!source) {
		if (
			payload.mode !== "repair-commit-messages" &&
			payload.diff.length > 3_000_000
		)
			throw new Error(
				"Legacy planning requires bounded complete partition source authority",
			);
		return call();
	}
	if (source.witness.repository !== payload.repository)
		throw new Error("Planning source belongs to another repository");
	const inputs = readPlanningPathInputs(
		payload.repository,
		source,
		payload.diffHash,
	);
	const paths = inputs.map((input) => input.path);
	if (payload.mode === "repair-commit-messages") {
		assertExactPlanningCoverage(payload.rejectedPlans, paths);
		const repaired = await call();
		assertExactPlanningCoverage(repaired, paths);
		assertValidatedSource(
			payload.repository,
			source.witness,
			source.committedShas,
			source.publisherIndexTreeSha,
		);
		return repaired;
	}
	if (
		createHash("sha256").update(payload.diff).digest("hex") !== payload.diffHash
	)
		throw new Error("Planning payload lost its full validated diff binding");
	const partitions = await partitionPlanningPaths(
		inputs,
		(partition) =>
			buildContextRequest(renderPlanningInvocation(payload, token, partition)),
		authority,
		source.maxDiffChars,
	);
	const aggregate: CommitPlan[] = [];
	const pending = [...partitions];
	const byPath = new Map(inputs.map((input) => [input.path, input.patch]));
	let leafCount = partitions.length;
	while (pending.length) {
		const partition = pending.shift();
		if (!partition) throw new Error("Missing planning unit");
		try {
			const plans = await call(partition);
			assertExactPlanningCoverage(plans, partition.paths);
			aggregate.push(...plans);
		} catch (error) {
			if (!(error instanceof ContextOverflowError)) throw error;
			if (partition.paths.length < 2)
				throw new ContextOverflowError(
					error.evidence,
					error.attempts ?? 1,
					"indivisible-path",
				);
			if (
				++leafCount > MAX_PLANNING_PARTITIONS ||
				MAX_PLANNING_CALLS - calls < pending.length + 2
			)
				throw new ContextOverflowError(
					error.evidence,
					error.attempts ?? 1,
					"planning-budget-exhausted",
				);
			const midpoint = Math.floor(partition.paths.length / 2);
			const children = [
				partition.paths.slice(0, midpoint),
				partition.paths.slice(midpoint),
			].map((paths) => ({
				paths,
				diff: paths
					.map((path) => {
						const patch = byPath.get(path);
						if (!patch) throw new Error("Missing pinned Git representation");
						return patch;
					})
					.join(""),
			}));
			pending.unshift(...children);
		}
	}
	assertExactPlanningCoverage(aggregate, paths);
	assertValidatedSource(
		payload.repository,
		source.witness,
		source.committedShas,
		source.publisherIndexTreeSha,
	);
	assertCommitPlanCoverage(
		payload.repository,
		aggregate,
		paths,
		source.witness.expectedChangedPaths,
	);
	return aggregate;
}
