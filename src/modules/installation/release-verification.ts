import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	createStandaloneReleaseName,
	isStandaloneReleaseName,
	requireStandalonePackageVersion,
} from "./release-identity.ts";
import { digestReleaseTree } from "./release-tree.ts";

/** Verify the named artifact itself, without deriving a replacement identity. */
export async function verifyStandaloneReleaseIdentity(
	releaseDirectory: string,
	expectedReleaseName: string,
): Promise<void> {
	if (!isStandaloneReleaseName(expectedReleaseName)) {
		throw new Error("Invalid standalone release name.");
	}
	const digest = await digestReleaseTree(releaseDirectory);
	if (digest !== expectedReleaseName.slice(-64)) {
		throw new Error("Standalone release digest verification failed.");
	}
	const manifest: { readonly name?: unknown; readonly version?: unknown } =
		JSON.parse(
			await readFile(path.join(releaseDirectory, "package.json"), "utf8"),
		);
	if (
		manifest.name !== "git-commits-push" ||
		createStandaloneReleaseName(
			requireStandalonePackageVersion(manifest.version),
			digest,
		) !== expectedReleaseName
	) {
		throw new Error("Standalone release version/identity verification failed.");
	}
}
