import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { assertInstalledReadPath } from "./fixtures/controlled-runtime-paths.mjs";

test("source-exclusion oracle distinguishes nested fixture data without admitting checkout reads", () => {
	const temp = mkdtempSync(path.join(tmpdir(), "gcp-source-exclusion-"));
	try {
		const source = path.join(temp, "checkout");
		const release = path.join(source, ".private", "image");
		const fixture = path.join(source, ".private", "case");
		for (const dir of [
			release,
			fixture,
			path.join(source, "src"),
			path.join(source, "vendor"),
			path.join(source, ".private", "case-neighbour"),
		])
			mkdirSync(dir, { recursive: true });
		for (const file of [
			path.join(release, "asset"),
			path.join(fixture, "settings.json"),
			path.join(source, "src", "private-source"),
			path.join(source, "vendor", "runtime.tgz"),
			path.join(source, ".private", "case-neighbour", "asset"),
		])
			writeFileSync(file, "synthetic canary\n");
		const roots = { source, release, fixture };
		for (const file of [
			path.join(release, "asset"),
			path.join(fixture, "settings.json"),
		]) {
			assert.doesNotThrow(() =>
				assertInstalledReadPath(file, roots, realpathSync),
			);
			assert.doesNotThrow(() =>
				assertInstalledReadPath(pathToFileURL(file), roots, realpathSync),
			);
		}
		for (const file of [
			path.join(source, "src", "private-source"),
			path.join(source, "vendor", "runtime.tgz"),
			path.join(source, ".private", "case-neighbour", "asset"),
			path.join(fixture, "..", "..", "src", "private-source"),
		]) {
			assert.throws(
				() => assertInstalledReadPath(file, roots, realpathSync),
				/unavailable source/,
			);
		}
		const alias = path.join(fixture, "checkout-alias");
		symlinkSync(path.join(source, "src", "private-source"), alias);
		assert.throws(
			() => assertInstalledReadPath(alias, roots, realpathSync),
			/unavailable source/,
		);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});
