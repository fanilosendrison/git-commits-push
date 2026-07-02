/**
 * src/settings.ts — Reads and validates settings.json from the skill directory.
 *
 * settings.json is not versioned — it lives alongside the skill binary.
 * The skill directory is derived from import.meta.url at runtime.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Settings } from "../types.ts";

const REQUIRED_FIELDS: Array<keyof Settings> = [
	"provider",
	"model",
	"temperature",
	"systemPromptPath",
	"autoPush",
	"skipTests",
];

export function readSettings(skillDir: string): Settings {
	const settingsPath = process.env.TURNLOCK_SKILL_SETTINGS_PATH || path.join(skillDir, "settings.json");

	if (!fs.existsSync(settingsPath)) {
		throw new Error(`settings.json not found at: ${settingsPath}`);
	}

	let raw: string;
	try {
		raw = fs.readFileSync(settingsPath, "utf-8");
	} catch (err) {
		throw new Error(`Failed to read settings.json: ${err instanceof Error ? err.message : String(err)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`settings.json is not valid JSON`);
	}

	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`settings.json must be a JSON object`);
	}

	const obj = parsed as Record<string, unknown>;

	for (const field of REQUIRED_FIELDS) {
		if (!(field in obj)) {
			throw new Error(`settings.json is missing required field: ${field}`);
		}
	}

	return {
		searchPaths: Array.isArray(obj["searchPaths"]) ? (obj["searchPaths"] as string[]) : [],
		provider: obj["provider"] as string,
		model: obj["model"] as string,
		temperature: obj["temperature"] as number,
		systemPromptPath: obj["systemPromptPath"] as string,
		autoPush: Boolean(obj["autoPush"]),
		skipTests: Boolean(obj["skipTests"]),
	};
}
