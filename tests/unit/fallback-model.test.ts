/**
 * tests/unit/fallback-model.test.ts — Tests for fallback model escalation
 *
 * When the default model exhausts its validation budget, the skill should
 * retry with a fallback model before failing.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	buildFallbackSettings,
	shouldUseFallback,
} from "../../src/modules/core/fallback-model.ts";
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
		assert.strictEqual(result, false);
	});

	test("returns false when attempt count < max", () => {
		const settings = {
			...BASE_SETTINGS,
			fallbackProvider: "openai",
			fallbackModel: "gpt-5.5",
		};
		const result = shouldUseFallback(settings, "validation", 1, false);
		assert.strictEqual(result, false);
	});

	test("returns false when fallback already attempted", () => {
		const settings = {
			...BASE_SETTINGS,
			fallbackProvider: "openai",
			fallbackModel: "gpt-5.5",
		};
		const result = shouldUseFallback(settings, "validation", 2, true);
		assert.strictEqual(result, false);
	});

	test("returns true when max reached and fallback available and not yet attempted", () => {
		const settings = {
			...BASE_SETTINGS,
			fallbackProvider: "openai",
			fallbackModel: "gpt-5.5",
		};
		const result = shouldUseFallback(settings, "validation", 2, false);
		assert.strictEqual(result, true);
	});

	test("only applies to validation kind (not structural/race/etc)", () => {
		const settings = {
			...BASE_SETTINGS,
			fallbackProvider: "openai",
			fallbackModel: "gpt-5.5",
		};
		assert.strictEqual(
			shouldUseFallback(settings, "structural", 1, false),
			false,
		);
		assert.strictEqual(shouldUseFallback(settings, "race", 1, false), false);
		assert.strictEqual(shouldUseFallback(settings, "git", 1, false), false);
		assert.strictEqual(shouldUseFallback(settings, "network", 1, false), false);
	});
});

describe("buildFallbackSettings", () => {
	test("returns settings with fallback provider/model", () => {
		const settings = {
			...BASE_SETTINGS,
			fallbackProvider: "openai",
			fallbackModel: "gpt-5.5",
		};

		const result = buildFallbackSettings(settings);

		assert.strictEqual(result.provider, "openai");
		assert.strictEqual(result.model, "gpt-5.5");
	});

	test("preserves other settings fields", () => {
		const settings = {
			...BASE_SETTINGS,
			fallbackProvider: "anthropic",
			fallbackModel: "claude-sonnet-4",
		};

		const result = buildFallbackSettings(settings);

		assert.strictEqual(result.temperature, 0);
		assert.strictEqual(result.autoPush, false);
	});
});
