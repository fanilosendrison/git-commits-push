import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const packageFileSchema = z
	.object({
		path: z
			.string()
			.min(1)
			.refine(
				(file) =>
					!file.startsWith("/") &&
					!file.includes("\\") &&
					file
						.split("/")
						.every((part) => part !== "" && part !== "." && part !== ".."),
			),
		size: z.number().int().nonnegative(),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
const provenanceSchema = z
	.object({
		name: z.literal("@fanilosendrison/llm-runtime"),
		version: z.literal("0.1.5"),
		sourceRepository: z.literal(
			"https://github.com/fanilosendrison/llm-runtime",
		),
		sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
		sourceTree: z.string().regex(/^[a-f0-9]{40}$/),
		tarball: z.literal("fanilosendrison-llm-runtime-0.1.5.tgz"),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		sha512: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
		files: z.array(packageFileSchema).min(1),
	})
	.passthrough();

async function readProvenance(file: string) {
	if (!(await lstat(file)).isFile())
		throw new Error("Runtime provenance must be a regular file");
	const p = provenanceSchema.parse(JSON.parse(await readFile(file, "utf8")));
	if (new Set(p.files.map((entry) => entry.path)).size !== p.files.length)
		throw new Error("Runtime provenance contains duplicate paths");
	return p;
}
const digest = (algorithm: string, bytes: Buffer) =>
	createHash(algorithm).update(bytes);
function within(root: string, file: string): boolean {
	const relative = path.relative(root, file);
	return (
		relative === "" ||
		(!path.isAbsolute(relative) &&
			relative !== ".." &&
			!relative.startsWith(`..${path.sep}`))
	);
}

/** Verify the immutable source-distribution input before producing compiled GCP assets. */
export async function verifyVendoredRuntimeTarball(
	sourceDirectory: string,
): Promise<void> {
	const vendor = path.join(sourceDirectory, "vendor", "llm-runtime");
	const p = await readProvenance(path.join(vendor, "provenance.json"));
	const file = path.join(vendor, p.tarball);
	if (!(await lstat(file)).isFile())
		throw new Error("Runtime tarball must be a regular file");
	const bytes = await readFile(file);
	if (
		digest("sha256", bytes).digest("hex") !== p.sha256 ||
		`sha512-${digest("sha512", bytes).digest("base64")}` !== p.sha512
	)
		throw new Error("Controlled runtime tarball integrity mismatch");
}

/** Installation gate: the deployed dependency must match every accepted package byte. */
export async function verifyInstalledRuntimePackage(
	releaseDirectory: string,
): Promise<void> {
	const root = await realpath(releaseDirectory);
	const p = await readProvenance(
		path.join(root, "dist", "dependency-provenance", "llm-runtime.json"),
	);
	const dependency = await realpath(
		path.join(root, "node_modules", "@fanilosendrison", "llm-runtime"),
	);
	if (!within(root, dependency))
		throw new Error("Runtime package escapes the deployment");
	const manifest = JSON.parse(
		await readFile(path.join(dependency, "package.json"), "utf8"),
	) as { name?: unknown; version?: unknown };
	if (manifest.name !== p.name || manifest.version !== p.version)
		throw new Error("Deployed runtime identity mismatch");
	for (const entry of p.files) {
		const file = path.join(dependency, entry.path);
		if (
			!(await lstat(file)).isFile() ||
			!within(dependency, await realpath(file))
		)
			throw new Error(
				"Deployed runtime inventory entry is not a contained regular file",
			);
		const bytes = await readFile(file);
		if (
			bytes.length !== entry.size ||
			digest("sha256", bytes).digest("hex") !== entry.sha256
		)
			throw new Error(`Deployed runtime package bytes mismatch: ${entry.path}`);
	}
	const actual: string[] = [];
	async function inventory(relative: string): Promise<void> {
		for (const entry of await readdir(path.join(dependency, relative), {
			withFileTypes: true,
		})) {
			if (relative === "" && entry.name === "node_modules") continue;
			const file = path.posix.join(relative, entry.name);
			if (entry.isDirectory()) await inventory(file);
			else if (entry.isFile()) actual.push(file);
			else throw new Error("Unexpected runtime package inventory entry type");
		}
	}
	await inventory("");
	const expected = p.files.map((entry) => entry.path).sort();
	actual.sort();
	if (
		actual.length !== expected.length ||
		actual.some((file, index) => file !== expected[index])
	)
		throw new Error(
			"Deployed runtime package inventory is incomplete or has unexpected files",
		);
}
