import * as fs from "node:fs";
import * as path from "node:path";

/** Load an optional prompt relative to its entrypoint module directory. */
export function loadSystemPrompt(
	entrypointDirectory: string,
	configuredPath: string | undefined,
): string {
	const promptPath = path.resolve(
		entrypointDirectory,
		configuredPath || "../../system-prompt.md",
	);
	return fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf-8") : "";
}
