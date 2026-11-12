import type { CommitPlan } from "../../types.ts";
import { CommitPlanError } from "../core/errors.ts";
import {
	admitContext,
	ContextAdmissionError,
} from "../llm/context-admission.ts";
import type { ContextAuthority, ContextRequest } from "../llm/context-types.ts";
import { MAX_PLANNING_PARTITIONS } from "../llm/planning-attempt-budget.ts";
import type { PlanningPartition, PlanningPathInput } from "./planning-types.ts";

/** Literal Git pathspecs also select descendants; coupled ownership is unsupported. */
export function assertIndependentPlanningPaths(paths: readonly string[]): void {
	const members = new Set(paths);
	for (const path of paths) {
		for (
			let slash = path.indexOf("/");
			slash >= 0;
			slash = path.indexOf("/", slash + 1)
		) {
			if (members.has(path.slice(0, slash)))
				throw new Error(
					"Unsupported coupled Git path ownership (file/directory transition)",
				);
		}
	}
}

/** Stronger partition membership, followed by the canonical publisher validators. */
export function assertExactPlanningCoverage(
	plans: readonly CommitPlan[],
	paths: readonly string[],
): void {
	const expected = new Set(paths);
	const seen = new Set<string>();
	if (!paths.length || expected.size !== paths.length)
		throw new Error("Invalid source planning membership");
	if (!plans.length)
		throw new CommitPlanError("Invalid exact planning coverage", "empty-plans");
	for (const plan of plans) {
		if (!plan.files.length)
			throw new CommitPlanError(
				"Empty partition plan membership",
				"missing-file",
			);
		for (const path of plan.files) {
			if (!expected.has(path))
				throw new CommitPlanError(
					"Invented partition plan membership",
					"nonexistent-file",
					[path],
				);
			if (seen.has(path))
				throw new CommitPlanError(
					"Duplicate partition plan membership",
					"duplicate-file",
					[path],
				);
			seen.add(path);
		}
	}
	if (seen.size !== expected.size)
		throw new CommitPlanError(
			"Incomplete exact planning coverage",
			"incomplete-coverage",
			paths.filter((path) => !seen.has(path)),
		);
}

/** Greedy literal-path grouping; only exact admission results guide capacity splits. */
export async function partitionPlanningPaths(
	inputs: readonly PlanningPathInput[],
	requestFor: (partition: PlanningPartition) => ContextRequest,
	authority: ContextAuthority,
	maxDiffChars: number,
): Promise<PlanningPartition[]> {
	if (!Number.isSafeInteger(maxDiffChars) || maxDiffChars < 1 || !inputs.length)
		throw new Error("Invalid planning representation bound or empty work");
	const sorted = [...inputs].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
	if (new Set(sorted.map((input) => input.path)).size !== sorted.length)
		throw new Error("Duplicate partition input membership");
	assertIndependentPlanningPaths(sorted.map((input) => input.path));
	const partitions: PlanningPartition[] = [];
	let pending: PlanningPathInput[] = [];
	const partition = (
		items: readonly PlanningPathInput[],
	): PlanningPartition => ({
		paths: items.map((item) => item.path),
		diff: items.map((item) => item.patch).join(""),
	});
	const fits = async (
		items: readonly PlanningPathInput[],
	): Promise<boolean> => {
		const p = partition(items);
		const decision = await admitContext(requestFor(p), authority);
		if (
			decision.status !== "ADMITTED" &&
			decision.status !== "REJECTED_INPUT_CAPACITY"
		)
			throw new ContextAdmissionError(decision.status);
		return decision.status === "ADMITTED" && p.diff.length <= maxDiffChars;
	};
	const flush = () => {
		if (partitions.length >= MAX_PLANNING_PARTITIONS)
			throw new Error("Planning partition bound exceeded");
		partitions.push(partition(pending));
	};
	for (const input of sorted) {
		if (!input.path || !input.patch)
			throw new Error("Insufficient path representation");
		if (await fits([...pending, input])) {
			pending.push(input);
			continue;
		}
		if (pending.length) flush();
		pending = [input];
		if (!(await fits(pending)))
			throw new Error(
				"REJECTED_INPUT_CAPACITY: indivisible path exceeds admission bound",
			);
	}
	if (pending.length) flush();
	const members = partitions.flatMap((p) => p.paths);
	if (
		members.length !== sorted.length ||
		new Set(members).size !== sorted.length
	)
		throw new Error("Partition coverage was not established");
	return partitions;
}
