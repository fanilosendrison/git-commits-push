import assert from "node:assert/strict";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { copyAssets } from "../src/index.ts";

async function withTemporaryDirectory(
	callback: (directory: string) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(path.join(tmpdir(), "node-runtime-assets-"));
	try {
		await callback(directory);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

test("copies an explicit asset manifest deterministically", async () => {
	await withTemporaryDirectory(async (directory) => {
		const sourceDirectory = path.join(directory, "source assets");
		const firstOutputDirectory = path.join(directory, "first output");
		const secondOutputDirectory = path.join(directory, "second output");
		await mkdir(path.join(sourceDirectory, "nested"), { recursive: true });
		await writeFile(
			path.join(sourceDirectory, "settings.json"),
			'{"enabled":true}\n',
		);
		await writeFile(
			path.join(sourceDirectory, "nested", "échantillon.bin"),
			Buffer.from([0, 1, 127, 255]),
		);
		await chmod(path.join(sourceDirectory, "settings.json"), 0o600);
		await chmod(path.join(sourceDirectory, "nested", "échantillon.bin"), 0o755);

		const manifest = [
			{
				sourcePath: "nested/échantillon.bin",
				destinationPath: "data/échantillon.bin",
			},
			{
				sourcePath: "settings.json",
				destinationPath: "config/settings.json",
			},
		] as const;
		await copyAssets({
			assets: manifest,
			destinationDirectory: firstOutputDirectory,
			sourceDirectory,
		});
		await copyAssets({
			assets: manifest.toReversed(),
			destinationDirectory: secondOutputDirectory,
			sourceDirectory,
		});

		for (const destinationPath of [
			"config/settings.json",
			"data/échantillon.bin",
		]) {
			const firstPath = path.join(firstOutputDirectory, destinationPath);
			const secondPath = path.join(secondOutputDirectory, destinationPath);
			assert.deepEqual(await readFile(firstPath), await readFile(secondPath));
			assert.equal((await stat(firstPath)).mode & 0o777, 0o644);
			assert.equal((await stat(secondPath)).mode & 0o777, 0o644);
		}
		assert.equal(
			await readFile(
				path.join(firstOutputDirectory, "config/settings.json"),
				"utf8",
			),
			'{"enabled":true}\n',
		);
	});
});

test("preflights every source before creating output", async () => {
	await withTemporaryDirectory(async (directory) => {
		const sourceDirectory = path.join(directory, "source");
		const destinationDirectory = path.join(directory, "output");
		await mkdir(sourceDirectory);
		await writeFile(path.join(sourceDirectory, "present.txt"), "present\n");

		await assert.rejects(
			copyAssets({
				assets: [
					{ sourcePath: "present.txt", destinationPath: "a.txt" },
					{ sourcePath: "missing.txt", destinationPath: "z.txt" },
				],
				destinationDirectory,
				sourceDirectory,
			}),
			/Missing or invalid asset source.*missing\.txt/,
		);
		await assert.rejects(stat(destinationDirectory), { code: "ENOENT" });
	});
});

test("rejects empty manifests and duplicate destinations", async () => {
	await withTemporaryDirectory(async (directory) => {
		await assert.rejects(
			copyAssets({
				assets: [],
				destinationDirectory: path.join(directory, "output"),
				sourceDirectory: directory,
			}),
			/Asset manifest must contain at least one file/,
		);
		await assert.rejects(
			copyAssets({
				assets: [
					{ sourcePath: "first.txt", destinationPath: "same.txt" },
					{ sourcePath: "second.txt", destinationPath: "same.txt" },
				],
				destinationDirectory: path.join(directory, "output"),
				sourceDirectory: directory,
			}),
			/Duplicate asset destination.*same\.txt/,
		);
	});
});

test("rejects source and destination paths outside their roots", async () => {
	await withTemporaryDirectory(async (directory) => {
		const cases = [
			{ sourcePath: "../outside.txt", destinationPath: "inside.txt" },
			{ sourcePath: "inside.txt", destinationPath: "../outside.txt" },
			{
				sourcePath: path.resolve("/outside.txt"),
				destinationPath: "inside.txt",
			},
			{
				sourcePath: "inside.txt",
				destinationPath: path.resolve("/outside.txt"),
			},
		] as const;

		for (const asset of cases) {
			await assert.rejects(
				copyAssets({
					assets: [asset],
					destinationDirectory: path.join(directory, "output"),
					sourceDirectory: directory,
				}),
				/Asset (source|destination) path must stay inside its root/,
			);
		}
	});
});
