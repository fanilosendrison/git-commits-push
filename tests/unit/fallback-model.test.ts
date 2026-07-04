/**
 * tests/unit/fallback-model.test.ts — Tests for fallback model escalation
 *
 * When the default model exhausts its validation budget, the skill should
 * retry with a fallback model before failing.
 */

import { describe, expect, test } from "bun:test";
import { shouldUseFallback } from "../../src/modules/fallback-model.ts";
import type { Settings } from "../../src/types.ts";

const BASE_SETTINGS: Settings = {
	searchPaths: [],
	provider: "deepseek",
	model: "deepseek-v4-flash",
	temperature: 0,
	systemPromptPath: "/dev/null",
	autoPush: false,
	skipTests: true,
};

describe("shouldUseFallback", () => {
	test("returns false when no fallback configured", () => {
		const result = shouldUseFallback(
			BASE_SETTINGS,
			"validation",
			2, // max reached
			false, // not yet attempted
		);
		expect(result).toBe(false);
	});

	test("returns false when attempt count < max", () => {
		const settings = {
			...BASE_SETTINGS,
			fallbackProvider: "openai",
			fallbackModel: "gpt-5.5",
		};
		const result = shouldUseFallback(settings, "validation", 1, false);
		expect(result).toBe(false);
	});

	test("returns false when fallback already attempted", () => {
		const settings = {
			...BASE_SETTINGS,
			fallbackProvider: "openai",
			fallbackModel: "gpt-5.5",
		};
		const result = shouldUseFallback(settings, "validation", 2, true);
		expect(result).toBe(false);
	});

	test("returns true when max reached and fallback available and not yet attempted", () => {
		const settings = {
			...BASE_SETTINGS,
			fallbackProvider: "openai",
			fallbackModel: "gpt-5.5",
		};
		const result = shouldUseFallback(settings, "validation", 2, false);
		expect(result).toBe(true);
	});

	test("only applies to validation kind (not structural/race/etc)", () => {
		const settings = {
			...BASE_SETTINGS,
			fallbackProvider: "openai",
			fallbackModel: "gpt-5.5",
		};
		expect(shouldUseFallback(settings, "structural", 1, false)).toBe(false);
		expect(shouldUseFallback(settings, "race", 1, false)).toBe(false);
		expect(shouldUseFallback(settings, "git", 1, false)).toBe(false);
		expect(shouldUseFallback(settings, "network", 1, false)).toBe(false);
	});
});

describe("buildFallbackSettings", () => {
	test("returns settings with fallback provider/model", () => {
		const settings = {
			...BASE_SETTINGS,
			fallbackProvider: "openai",
			fallbackModel: "gpt-5.5",
		};

		// Import dynamic
		const {
			buildFallbackSettings,
		} = require("../../src/modules/fallback-model.ts");
		const result = buildFallbackSettings(settings);

		expect(result.provider).toBe("openai");
		expect(result.model).toBe("gpt-5.5");
	});

	test("preserves other settings fields", () => {
		const settings = {
			...BASE_SETTINGS,
			fallbackProvider: "anthropic",
			fallbackModel: "claude-sonnet-4",
		};

		const {
			buildFallbackSettings,
		} = require("../../src/modules/fallback-model.ts");
		const result = buildFallbackSettings(settings);

		expect(result.temperature).toBe(0);
		expect(result.autoPush).toBe(false);
	});
});
