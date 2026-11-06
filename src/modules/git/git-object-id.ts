/** Full non-null Git object identity; accepts supported SHA-1/SHA-256 formats. */
export function isFullGitObjectId(value: string): boolean {
	return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value) && !/^0+$/u.test(value);
}

/** Parse a successful ls-remote exact-ref response, never a pattern match as authority. */
export function parseRemoteRefObservation(
	output: string,
	ref: string,
): string | null {
	if (output === "") return null;
	const entries = output.split("\n");
	if (entries.pop() !== "" || entries.length !== 1)
		throw new Error("Invalid or ambiguous remote ref observation.");
	const entry = entries[0]?.split("\t");
	const sha = entry?.[0];
	if (
		entry?.length !== 2 ||
		entry[1] !== ref ||
		!sha ||
		!isFullGitObjectId(sha)
	)
		throw new Error("Invalid remote object ID or non-exact ref observation.");
	return sha;
}
