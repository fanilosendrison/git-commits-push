import type { CommitPlan } from "../../types.ts";
import { CommitPlanError } from "../core/errors.ts";
import {
	authorizeContextExecution,
	isSplittableRequestRefusal,
} from "../llm/context-execution.ts";
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

/** Greedy whole-path grouping under the selected capacity or operational policy. */
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
		try {
			await authorizeContextExecution(requestFor(p), authority);
			return p.diff.length <= maxDiffChars;
		} catch (error) {
			if (isSplittableRequestRefusal(error)) return false;
			throw error;
		}
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
				"PLANNING_UNIT_LIMIT: indivisible path exceeds selected request/resource bound",
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
