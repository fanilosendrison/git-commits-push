import type { InvocationScope } from "../../types.ts";

const VALUE_FLAGS = [
	"--repository",
	"--push-remote",
	"--push-ref",
	"--base-ref",
	"--base-sha",
] as const;
const CREATE_FLAG = "--create-if-absent";
const OWNED_FLAGS: readonly string[] = [...VALUE_FLAGS, CREATE_FLAG];
type ValueFlag = (typeof VALUE_FLAGS)[number];

export type InvocationRequest =
	| { readonly kind: "worktree" }
	| Exclude<InvocationScope, { kind: "global" | "worktree" }>;
export interface ParsedInvocationArguments {
	readonly request: InvocationRequest;
	readonly passthroughArguments: readonly string[];
}

/** Pure atomic CLI grammar. No ambient state or I/O may grant authority here. */
export function parseInvocationArguments(
	args: readonly string[],
): ParsedInvocationArguments {
	const values = new Map<ValueFlag, string>();
	const seen = new Set<string>();
	const passthroughArguments: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === undefined) continue;
		if (OWNED_FLAGS.some((flag) => argument.startsWith(`${flag}=`)))
			throw new Error(
				"Targeted invocation does not accept --flag=value syntax.",
			);
		if (!OWNED_FLAGS.includes(argument)) {
			passthroughArguments.push(argument);
			continue;
		}
		if (seen.has(argument))
			throw new Error(`Duplicate targeted invocation flag: ${argument}.`);
		seen.add(argument);
		if (argument === CREATE_FLAG) {
			const next = args[index + 1];
			if (next !== undefined && !next.startsWith("--"))
				throw new Error(
					"--create-if-absent is a presence-only boolean without a value.",
				);
			continue;
		}
		const value = args[++index];
		if (value === undefined || value.length === 0 || value.startsWith("--"))
			throw new Error(
				`Targeted invocation flag ${argument} requires exactly one value.`,
			);
		values.set(argument as ValueFlag, value);
	}
	if (seen.size === 0)
		return { request: { kind: "worktree" }, passthroughArguments };
	if (args.some((arg) => arg === "--resume" || arg.startsWith("--resume=")))
		throw new Error(
			"targeted invocation arguments cannot be supplied with --resume; resume uses the persisted invocation scope",
		);
	const repository = values.get("--repository");
	const pushRemote = values.get("--push-remote");
	const pushRef = values.get("--push-ref");
	if (
		repository === undefined ||
		pushRemote === undefined ||
		pushRef === undefined
	)
		throw new Error(
			"Targeted invocation requires all three flags together: --repository, --push-remote, and --push-ref.",
		);
	const baseRef = values.get("--base-ref");
	const baseSha = values.get("--base-sha");
	const create = seen.has(CREATE_FLAG);
	if (create || baseRef !== undefined || baseSha !== undefined) {
		if (!create || baseRef === undefined || baseSha === undefined)
			throw new Error(
				"Creation requires --create-if-absent, --base-ref and --base-sha together with the complete targeted group.",
			);
		return {
			request: {
				kind: "targeted-create",
				repository,
				pushRemote,
				pushRef,
				baseRef,
				baseSha,
			},
			passthroughArguments,
		};
	}
	return {
		request: { kind: "targeted", repository, pushRemote, pushRef },
		passthroughArguments,
	};
}
