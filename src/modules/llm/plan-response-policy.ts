import { ZodError } from "zod";

/** Commit-plan JSON is data: never remove tag-shaped text inside its strings. */
export const PLAN_RESPONSE_SANITIZATION = Object.freeze({
	stripThinkingTags: false,
});

const SCHEMA_PATH_FIELDS = new Set([
	"commit",
	"files",
	"type",
	"scope",
	"description",
	"body",
	"isBreaking",
	"planIndex",
]);

/** Report only structural metadata; never response text, issue messages or hashes. */
export function reportPlanResponseRejection(
	error: unknown,
	attempt: number,
	willRepeat: boolean,
	stripJsonFence: boolean,
): unknown {
	const stage =
		error instanceof SyntaxError
			? "json"
			: error instanceof ZodError
				? "schema"
				: "contract";
	const issues =
		error instanceof ZodError
			? error.issues.slice(0, 8).map((issue) => ({
					code: issue.code,
					path: issue.path
						.slice(0, 6)
						.map((segment) =>
							typeof segment === "number" &&
							Number.isSafeInteger(segment) &&
							segment >= 0
								? segment
								: typeof segment === "string" && SCHEMA_PATH_FIELDS.has(segment)
									? segment
									: "unrecognized",
						),
				}))
			: [];
	process.stderr.write(
		`${JSON.stringify({
			event: "commit_plan_response_rejected",
			attempt,
			stage,
			issues,
			sanitization: { ...PLAN_RESPONSE_SANITIZATION, stripJsonFence },
			classification: willRepeat
				? "bounded_repeat"
				: "terminal_response_rejection",
		})}\n`,
	);
	// SyntaxError.message may quote arbitrary response text. Zod messages can
	// likewise include received values; only the structural event is admissible.
	return error instanceof SyntaxError || error instanceof ZodError
		? new Error(`Commit-plan response rejected (${stage})`)
		: error;
}
