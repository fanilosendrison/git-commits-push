import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

	test("preserves fallback and thinking settings", () => {
		const dir = writeSettings({
			...baseSettings,
			thinking: true,
			fallbackProvider: "deepseek",
			fallbackModel: "deepseek-v4-pro",
		});

		const settings = readSettings(dir);

		expect(settings.provider).toBe("deepseek");
		expect(settings.model).toBe("deepseek-v4-flash");
		expect(settings.thinking).toBe(true);
		expect(settings.fallbackProvider).toBe("deepseek");
		expect(settings.fallbackModel).toBe("deepseek-v4-pro");
	});

	test("rejects incomplete fallback configuration", () => {
		const dir = writeSettings({
			...baseSettings,
			fallbackProvider: "deepseek",
		});

		expect(() => readSettings(dir)).toThrow(
			"fallbackProvider and fallbackModel",
		);
	});
});
