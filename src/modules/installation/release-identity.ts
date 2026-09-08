const STABLE_SEMVER_PATTERN_SOURCE = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)`;
const PACKAGE_VERSION_PATTERN = new RegExp(`^${STABLE_SEMVER_PATTERN_SOURCE}$`);
const RELEASE_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_NAME_PATTERN = new RegExp(
	`^${STABLE_SEMVER_PATTERN_SOURCE}-[a-f0-9]{64}$`,
);

/** Require the unambiguous stable semantic version supported by release names. */
export function requireStandalonePackageVersion(value: unknown): string {
	if (typeof value !== "string" || !PACKAGE_VERSION_PATTERN.test(value)) {
		throw new Error("Deployed package manifest is invalid.");
	}
	return value;
}

/** Bind a supported package version to the complete deterministic tree digest. */
export function createStandaloneReleaseName(
	version: string,
	digest: string,
): string {
	requireStandalonePackageVersion(version);
	if (!RELEASE_DIGEST_PATTERN.test(digest)) {
		throw new Error("Standalone release digest must be a complete SHA-256.");
	}
	return `${version}-${digest}`;
}

/** Validate a content-addressed standalone release directory name. */
export function isStandaloneReleaseName(candidate: string): boolean {
	return RELEASE_NAME_PATTERN.test(candidate);
}
