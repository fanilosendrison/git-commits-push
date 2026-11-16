import { parseArgs } from "node:util";
import { isStandaloneReleaseName } from "./release-identity.ts";

/** Parse the optional exact release pin; unknown, repeated and malformed input refuses. */
export function parseExpectedStandaloneRelease(
	argumentsList: readonly string[],
): string | undefined {
	const parsed = parseArgs({
		args: [...argumentsList],
		allowPositionals: false,
		strict: true,
		tokens: true,
		options: { "expected-release": { type: "string" } },
	});
	if (
		parsed.tokens.filter(
			(token) => token.kind === "option" && token.name === "expected-release",
		).length > 1
	) {
		throw new Error("Expected standalone release may be specified only once.");
	}
	const expected = parsed.values["expected-release"];
	if (expected !== undefined && !isStandaloneReleaseName(expected)) {
		throw new Error("Invalid expected standalone release name.");
	}
	return expected;
}
