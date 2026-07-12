import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function isKeyedTokenConfig(value: unknown): value is { key: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"key" in value &&
		typeof (value as Record<string, unknown>).key === "string"
	);
}

export async function resolveAuthToken(
	provider: string,
	agent?: string,
): Promise<string> {
	const envKey = `${provider.toUpperCase()}_API_KEY`;

	// 1. Check System Environment Variable
	if (process.env[envKey]) {
		return process.env[envKey].trim();
	}

	// 2. Read ~/.agents/agent-credentials.json
	const authFilePath = path.join(
		os.homedir(),
		".agents",
		"agent-credentials.json",
	);
	let authData: Record<string, unknown>;
	try {
		const raw = fs.readFileSync(authFilePath, "utf-8");
		authData = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		throw new Error(
			`Authentication token for provider ${provider} not found in env and failed to read agent-credentials.json`,
		);
	}

	// 3. Resolve token config — nested agent map or flat provider entry
	let tokenConfig: unknown = authData[provider];

	if (agent && tokenConfig && typeof tokenConfig === "object" && !("key" in tokenConfig)) {
		// Nested format: { "deepseek": { "janet": { "key": "..." }, ... } }
		const agentMap = tokenConfig as Record<string, unknown>;
		tokenConfig = agentMap[agent];
		if (!tokenConfig) {
			throw new Error(
				`Authentication token for provider ${provider}, agent ${agent} not found in agent-credentials.json`,
			);
		}
	}

	if (!tokenConfig) {
		throw new Error(
			`Authentication token for provider ${provider} not found in env or agent-credentials.json`,
		);
	}

	let tokenConfigStr: string;
	if (typeof tokenConfig === "string") {
		tokenConfigStr = tokenConfig;
	} else if (isKeyedTokenConfig(tokenConfig)) {
		tokenConfigStr = tokenConfig.key;
	} else {
		const suffix = agent ? ` (agent: ${agent})` : "";
		throw new Error(
			`Authentication token for provider ${provider}${suffix} in agent-credentials.json is malformed`,
		);
	}

	const trimmedConfig = tokenConfigStr.trim();

	// 4. Dynamic Execution
	try {
		// execSync throws if exit code !== 0, which correctly propagates
		const result = execSync(trimmedConfig, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return result.trim();
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		const suffix = agent ? ` (agent: ${agent})` : "";
		throw new Error(
			`Failed to execute credential command for provider ${provider}${suffix}. Ensure the key in agent-credentials.json is a valid shell command (e.g. doppler). Error: ${message}`,
		);
	}
}
