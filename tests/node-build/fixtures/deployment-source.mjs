import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

/** Existing installation fixture: copy only deployable assets, never a source checkout dependency. */
export async function copyDeploymentSource(sourceDirectory, targetDirectory) {
	await mkdir(targetDirectory, { recursive: true });
	for (const entry of [
		".npmrc",
		"bin",
		"dist",
		"package.json",
		"vendor",
		"pnpm-lock.yaml",
		"pnpm-workspace.yaml",
	])
		await cp(
			path.join(sourceDirectory, entry),
			path.join(targetDirectory, entry),
			{ recursive: true },
		);
	for (const packageName of ["node-runtime", "trust"]) {
		const targetPackage = path.join(targetDirectory, "packages", packageName);
		await mkdir(targetPackage, { recursive: true });
		for (const entry of ["dist", "package.json"])
			await cp(
				path.join(sourceDirectory, "packages", packageName, entry),
				path.join(targetPackage, entry),
				{ recursive: true },
			);
	}
}
