import assert from "node:assert/strict";
import { test } from "node:test";
import { parseYaml, YamlParseError } from "../src/index.ts";

const scalarReferenceSource = `
trueValue: true
falseValue: false
nullValue: null
integer: 42
negative: -7
float: 3.25
exponent: 1.5e2
yesWord: yes
dateText: 2026-08-27
items:
  - one
  - 2
`;

const multiDocumentReferenceSource = `
---
name: first
enabled: true
---
name: second
enabled: false
`;

function getBunYamlParser(): ((source: string) => unknown) | null {
	const runtime = globalThis as typeof globalThis & {
		readonly Bun?: {
			readonly YAML?: { readonly parse?: (source: string) => unknown };
		};
	};
	const yaml = runtime.Bun?.YAML;
	return typeof yaml?.parse === "function"
		? (source: string) => yaml.parse?.(source)
		: null;
}

test("parses Bun-compatible YAML 1.2 core scalars and collections", () => {
	assert.deepEqual(parseYaml(scalarReferenceSource), {
		trueValue: true,
		falseValue: false,
		nullValue: null,
		integer: 42,
		negative: -7,
		float: 3.25,
		exponent: 150,
		yesWord: "yes",
		dateText: "2026-08-27",
		items: ["one", 2],
	});
});

test("uses the fixed core schema instead of timestamp coercion", () => {
	const parsed = parseYaml("created: 2026-08-27T12:34:56Z\n") as {
		readonly created: unknown;
	};
	assert.equal(parsed.created, "2026-08-27T12:34:56Z");
	assert.throws(
		() => parseYaml("created: !!timestamp 2026-08-27T12:34:56Z\n"),
		(error: unknown) => {
			assert.ok(error instanceof YamlParseError);
			assert.match(error.message, /unknown tag.*timestamp/i);
			return true;
		},
	);
});

test("preserves shared identity for aliases", () => {
	const parsed = parseYaml(`
shared: &shared
  value: 42
first: *shared
second: *shared
`) as {
		readonly shared: object;
		readonly first: object;
		readonly second: object;
	};

	assert.strictEqual(parsed.first, parsed.shared);
	assert.strictEqual(parsed.second, parsed.shared);
});

test("preserves cyclic aliases", () => {
	const parsed = parseYaml("root: &root\n  self: *root\n") as {
		readonly root: { readonly self: unknown };
	};
	assert.strictEqual(parsed.root.self, parsed.root);
});

test("returns all documents with Bun-compatible multi-document semantics", () => {
	assert.deepEqual(parseYaml(multiDocumentReferenceSource), [
		{ name: "first", enabled: true },
		{ name: "second", enabled: false },
	]);
});

test("rejects duplicate mapping keys", () => {
	assert.throws(
		() =>
			parseYaml("name: first\nname: second\n", { sourceName: "config.yaml" }),
		(error: unknown) => {
			assert.ok(error instanceof YamlParseError);
			assert.equal(error.sourceName, "config.yaml");
			assert.equal(error.line, 2);
			assert.equal(error.column, 1);
			assert.match(error.message, /duplicated mapping key/i);
			return true;
		},
	);
});

test("reports actionable source and location details for invalid YAML", () => {
	assert.throws(
		() => parseYaml("items: [one, two\n", { sourceName: "STACK_EVAL.yaml" }),
		(error: unknown) => {
			assert.ok(error instanceof YamlParseError);
			assert.equal(error.sourceName, "STACK_EVAL.yaml");
			assert.equal(error.line, 2);
			assert.ok(error.column !== null);
			assert.match(error.message, /STACK_EVAL\.yaml/);
			assert.match(error.message, /line 2, column \d+/);
			assert.ok(error.cause instanceof Error);
			return true;
		},
	);
});

const bunYamlParser = getBunYamlParser();
test("matches Bun 1.3.14 on scalar and multi-document reference vectors", {
	skip: bunYamlParser === null,
}, () => {
	assert.ok(bunYamlParser !== null);
	for (const source of [scalarReferenceSource, multiDocumentReferenceSource]) {
		assert.deepEqual(parseYaml(source), bunYamlParser(source));
	}
});
