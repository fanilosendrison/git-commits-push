import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import { readSettings } from "../../src/config/settings.ts";

let settingsDir: string | undefined;

function writeSettings(content: Record<string, unknown>): string {
	settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gcp-settings-"));
	fs.writeFileSync(
		path.join(settingsDir, "settings.json"),
		JSON.stringify(content, null, 2),
		"utf-8",
	);
	return settingsDir;
}

afterEach(() => {
	if (settingsDir && fs.existsSync(settingsDir)) {
		fs.rmSync(settingsDir, { recursive: true, force: true });
	}
	settingsDir = undefined;
});

describe("readSettings", () => {
	const baseSettings = {
		searchPaths: ["/workspace"],
		provider: "deepseek",
		model: "deepseek-v4-flash",
		temperature: 0.2,
		systemPromptPath: "../../system-prompt.md",
		autoPush: true,
		skipTests: false,
	};

	test("uses DeepSeek V4 Flash with DeepSeek V4 Pro fallback by default", () => {
		const settings = readSettings(
			path.resolve(import.meta.dirname, "../../src/config"),
		);

		assert.strictEqual(settings.provider, "deepseek");
		assert.strictEqual(settings.model, "deepseek-v4-flash");
		assert.strictEqual(settings.fallbackProvider, "deepseek");
		assert.strictEqual(settings.fallbackModel, "deepseek-v4-pro");
		assert.strictEqual(settings.agent, "git-commits-push");
	});

	test("preserves fallback and thinking settings", () => {
		const dir = writeSettings({
			...baseSettings,
			thinking: true,
			fallbackProvider: "deepseek",
			fallbackModel: "deepseek-v4-pro",
		});

		const settings = readSettings(dir);

		assert.strictEqual(settings.provider, "deepseek");
		assert.strictEqual(settings.model, "deepseek-v4-flash");
		assert.strictEqual(settings.thinking, true);
		assert.strictEqual(settings.fallbackProvider, "deepseek");
		assert.strictEqual(settings.fallbackModel, "deepseek-v4-pro");
	});

	test("rejects incomplete fallback configuration", () => {
		const dir = writeSettings({
			...baseSettings,
			fallbackProvider: "deepseek",
		});

		assert.throws(
			() => readSettings(dir),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes("fallbackProvider and fallbackModel"),
		);
	});
});
