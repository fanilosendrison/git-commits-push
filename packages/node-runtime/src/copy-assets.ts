import { chmod, copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const COPIED_ASSET_MODE = 0o644;

export interface AssetCopyEntry {
	readonly sourcePath: string;
	readonly destinationPath: string;
}

export interface CopyAssetsOptions {
	readonly sourceDirectory: string;
	readonly destinationDirectory: string;
	readonly assets: readonly AssetCopyEntry[];
}

interface PreparedAssetCopy {
	readonly sourcePath: string;
	readonly destinationPath: string;
	readonly sourceRelativePath: string;
	readonly destinationRelativePath: string;
}

function resolvePathInsideRoot(
	rootDirectory: string,
	relativePath: string,
	kind: "source" | "destination",
): { readonly absolutePath: string; readonly normalizedRelativePath: string } {
	const absoluteRoot = path.resolve(rootDirectory);
	const absolutePath = path.resolve(absoluteRoot, relativePath);
	const normalizedRelativePath = path.relative(absoluteRoot, absolutePath);
	const escapesRoot =
		normalizedRelativePath === ".." ||
		normalizedRelativePath.startsWith(`..${path.sep}`) ||
		path.isAbsolute(normalizedRelativePath);
	if (
		relativePath.length === 0 ||
		normalizedRelativePath.length === 0 ||
		escapesRoot
	) {
		throw new Error(
			`Asset ${kind} path must stay inside its root: ${JSON.stringify(relativePath)}`,
		);
	}
	return { absolutePath, normalizedRelativePath };
}

function comparePreparedAssets(
	left: PreparedAssetCopy,
	right: PreparedAssetCopy,
): number {
	if (left.destinationRelativePath < right.destinationRelativePath) {
		return -1;
	}
	if (left.destinationRelativePath > right.destinationRelativePath) {
		return 1;
	}
	return 0;
}

function prepareAssetCopies(options: CopyAssetsOptions): PreparedAssetCopy[] {
	if (options.assets.length === 0) {
		throw new Error("Asset manifest must contain at least one file");
	}

	const destinations = new Set<string>();
	const preparedAssets = options.assets.map((asset) => {
		const source = resolvePathInsideRoot(
			options.sourceDirectory,
			asset.sourcePath,
			"source",
		);
		const destination = resolvePathInsideRoot(
			options.destinationDirectory,
			asset.destinationPath,
			"destination",
		);
		if (destinations.has(destination.absolutePath)) {
			throw new Error(
				`Duplicate asset destination: ${JSON.stringify(asset.destinationPath)}`,
			);
		}
		destinations.add(destination.absolutePath);
		return {
			sourcePath: source.absolutePath,
			destinationPath: destination.absolutePath,
			sourceRelativePath: source.normalizedRelativePath,
			destinationRelativePath: destination.normalizedRelativePath,
		};
	});
	return preparedAssets.sort(comparePreparedAssets);
}

async function preflightSources(
	assets: readonly PreparedAssetCopy[],
): Promise<void> {
	for (const asset of assets) {
		try {
			const sourceStats = await stat(asset.sourcePath);
			if (!sourceStats.isFile()) {
				throw new Error("source is not a regular file");
			}
		} catch (cause: unknown) {
			throw new Error(
				`Missing or invalid asset source: ${JSON.stringify(asset.sourceRelativePath)}`,
				{ cause },
			);
		}
	}
}

export async function copyAssets(options: CopyAssetsOptions): Promise<void> {
	const preparedAssets = prepareAssetCopies(options);
	await preflightSources(preparedAssets);

	for (const asset of preparedAssets) {
		await mkdir(path.dirname(asset.destinationPath), { recursive: true });
		await rm(asset.destinationPath, { force: true });
		await copyFile(asset.sourcePath, asset.destinationPath);
		await chmod(asset.destinationPath, COPIED_ASSET_MODE);
	}
}
