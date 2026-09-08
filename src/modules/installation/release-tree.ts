import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";

interface ReleaseTreeEntry {
	readonly absolutePath: string;
	readonly relativePath: string;
	readonly executableMode: number;
	readonly type: "directory" | "file" | "symlink";
	readonly symlinkTarget?: string;
}

function staysWithinRoot(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

async function collectReleaseTreeEntries(
	rootDirectory: string,
): Promise<readonly ReleaseTreeEntry[]> {
	const rootStats = await lstat(rootDirectory);
	if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
		throw new Error(
			`Release root must be a physical directory: ${rootDirectory}`,
		);
	}
	const physicalRoot = await realpath(rootDirectory);
	const entries: ReleaseTreeEntry[] = [];

	async function visit(directory: string): Promise<void> {
		const children = await readdir(directory, { withFileTypes: true });
		children.sort((left, right) =>
			left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
		);
		for (const child of children) {
			const absolutePath = path.join(directory, child.name);
			const relativePath = path
				.relative(rootDirectory, absolutePath)
				.split(path.sep)
				.join("/");
			const stats = await lstat(absolutePath);
			const executableMode = stats.mode & 0o111;
			if (stats.isDirectory() && !stats.isSymbolicLink()) {
				entries.push({
					absolutePath,
					executableMode,
					relativePath,
					type: "directory",
				});
				await visit(absolutePath);
				continue;
			}
			if (stats.isFile()) {
				entries.push({
					absolutePath,
					executableMode,
					relativePath,
					type: "file",
				});
				continue;
			}
			if (stats.isSymbolicLink()) {
				const symlinkTarget = await readlink(absolutePath);
				if (path.isAbsolute(symlinkTarget)) {
					throw new Error(
						`Symlink escapes the release tree: ${relativePath} -> ${symlinkTarget}`,
					);
				}
				const lexicalTarget = path.resolve(
					path.dirname(absolutePath),
					symlinkTarget,
				);
				if (!staysWithinRoot(rootDirectory, lexicalTarget)) {
					throw new Error(
						`Symlink escapes the release tree: ${relativePath} -> ${symlinkTarget}`,
					);
				}
				let physicalTarget: string;
				try {
					physicalTarget = await realpath(absolutePath);
				} catch (error) {
					throw new Error(
						`Release symlink is broken: ${relativePath} -> ${symlinkTarget}`,
						{ cause: error },
					);
				}
				if (!staysWithinRoot(physicalRoot, physicalTarget)) {
					throw new Error(
						`Symlink escapes the release tree: ${relativePath} -> ${symlinkTarget}`,
					);
				}
				entries.push({
					absolutePath,
					executableMode,
					relativePath,
					symlinkTarget,
					type: "symlink",
				});
				continue;
			}
			throw new Error(`Release contains a special file: ${relativePath}`);
		}
	}

	await visit(rootDirectory);
	return entries;
}

function updateDigestField(
	hash: ReturnType<typeof createHash>,
	value: string,
): void {
	const bytes = Buffer.from(value, "utf8");
	hash.update(String(bytes.length));
	hash.update(":");
	hash.update(bytes);
}

/** Validate that a deployed release is self-contained and contains no special files. */
export async function validateReleaseTree(
	rootDirectory: string,
): Promise<void> {
	await collectReleaseTreeEntries(path.resolve(rootDirectory));
}

/** Build a deterministic digest over release paths, types, modes, bytes and links. */
export async function digestReleaseTree(
	rootDirectory: string,
): Promise<string> {
	const entries = await collectReleaseTreeEntries(path.resolve(rootDirectory));
	const hash = createHash("sha256");
	for (const entry of entries) {
		updateDigestField(hash, entry.relativePath);
		updateDigestField(hash, entry.type);
		updateDigestField(hash, entry.executableMode.toString(8));
		if (entry.type === "file") {
			const content = await readFile(entry.absolutePath);
			updateDigestField(hash, String(content.length));
			hash.update(content);
		} else if (entry.type === "symlink") {
			updateDigestField(hash, entry.symlinkTarget ?? "");
		}
	}
	return hash.digest("hex");
}
