import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createOpenAICompatibleAdapter } from "@fanilosendrison/llm-runtime";

const root = path.resolve(import.meta.dirname, "../..");
const provenancePath = path.join(root, "vendor/llm-runtime/provenance.json");
const { verifyVendoredRuntimeTarball, verifyInstalledRuntimePackage } =
	await import(
		pathToFileURL(
			path.join(
				root,
				"dist/src/modules/installation/runtime-package-provenance.js",
			),
		).href
	);

test("controlled runtime tar has exact accepted provenance and immutable content identity", () => {
	const p = JSON.parse(readFileSync(provenancePath, "utf8"));
	assert.equal(p.name, "@fanilosendrison/llm-runtime");
	assert.equal(p.version, "0.1.5");
	assert.equal(p.sourceCommit, "f2ab2f723775bbfe8a40a597be84769819eb1e0e");
	assert.equal(p.sourceTree, "7f30975a2d6e5c3b7d6ab3430f50c8f249258c39");
	assert.equal(
		p.sha256,
		"f27f5b12adcb50d28fadbdc96ca201de6c861add8ca4ed919f8570e7de5a9353",
	);
	const bytes = readFileSync(path.join(root, "vendor/llm-runtime", p.tarball));
	assert.equal(createHash("sha256").update(bytes).digest("hex"), p.sha256);
	assert.equal(
		`sha512-${createHash("sha512").update(bytes).digest("base64")}`,
		p.sha512,
	);
	assert.equal(p.files.length, 147);
	const manifest = JSON.parse(
		readFileSync(path.join(root, "package.json"), "utf8"),
	);
	assert.equal(
		manifest.dependencies[p.name],
		`file:vendor/llm-runtime/${p.tarball}`,
	);
	assert.equal(
		existsSync(
			path.join(root, "patches/@fanilosendrison__llm-runtime@0.1.3.patch"),
		),
		false,
	);
});

test("actually resolved runtime decodes final Mistral chunks before GCP plan parsing", async () => {
	const adapter = createOpenAICompatibleAdapter({
		provider: "mistral",
		model: "synthetic",
		apiKey: "synthetic",
		sanitization: { stripThinkingTags: false, stripJsonFence: false },
		logging: { enabled: false },
		providerOptions: {
			fetch: async () =>
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: [
										{
											type: "thinking",
											thinking: [
												{ type: "text", text: "PRIVATE_REASONING_SENTINEL" },
											],
										},
										{ type: "text", text: '[{"files":' },
										{ type: "text", text: '["a.ts"]}]' },
									],
								},
								finish_reason: "stop",
							},
						],
					}),
				),
		},
	});
	const response = await adapter.call({
		messages: [{ role: "user", content: "synthetic" }],
		maxTokens: 4096,
	});
	assert.equal(response.rawContent, '[{"files":["a.ts"]}]');
	assert.equal(response.content, response.rawContent);
	assert.ok(!JSON.stringify(response).includes("PRIVATE_REASONING_SENTINEL"));
});

test("build and deployment provenance gates reject changed bytes and incomplete inventories", async () => {
	await verifyVendoredRuntimeTarball(root);
	await verifyInstalledRuntimePackage(root);
	const temporary = mkdtempSync(
		path.join(tmpdir(), "controlled-runtime-integrity-"),
	);
	try {
		const vendor = path.join(temporary, "vendor/llm-runtime");
		mkdirSync(vendor, { recursive: true });
		cpSync(path.join(root, "vendor/llm-runtime"), vendor, { recursive: true });
		const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
		writeFileSync(path.join(vendor, provenance.tarball), "tampered archive");
		await assert.rejects(
			verifyVendoredRuntimeTarball(temporary),
			/integrity mismatch/,
		);
		const dependency = path.join(
			temporary,
			"node_modules/@fanilosendrison/llm-runtime",
		);
		cpSync(
			path.join(root, "node_modules/@fanilosendrison/llm-runtime"),
			dependency,
			{ recursive: true, dereference: true },
		);
		const evidenceDirectory = path.join(
			temporary,
			"dist/dependency-provenance",
		);
		mkdirSync(evidenceDirectory, { recursive: true });
		const evidence = path.join(evidenceDirectory, "llm-runtime.json");
		cpSync(provenancePath, evidence);
		await verifyInstalledRuntimePackage(temporary);
		const changed = path.join(
			dependency,
			"dist/bindings/_internal/mistral-response.js",
		);
		const original = readFileSync(changed);
		writeFileSync(changed, "tampered decoder");
		await assert.rejects(
			verifyInstalledRuntimePackage(temporary),
			/bytes mismatch/,
		);
		writeFileSync(changed, original);
		writeFileSync(path.join(dependency, "unexpected.js"), "export {};\n");
		await assert.rejects(
			verifyInstalledRuntimePackage(temporary),
			/unexpected files/,
		);
		rmSync(path.join(dependency, "unexpected.js"));
		writeFileSync(
			evidence,
			JSON.stringify({ ...provenance, files: provenance.files.slice(1) }),
		);
		await assert.rejects(
			verifyInstalledRuntimePackage(temporary),
			/incomplete/,
		);
		writeFileSync(
			evidence,
			JSON.stringify({
				...provenance,
				files: [{ ...provenance.files[0], path: "../escape" }],
			}),
		);
		await assert.rejects(verifyInstalledRuntimePackage(temporary));
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});
