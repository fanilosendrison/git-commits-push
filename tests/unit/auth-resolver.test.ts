// tests/unit/auth-resolver.test.ts — Unit tests for src/modules/auth-resolver.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAuthToken } from "../../src/modules/auth-resolver.ts";

const MOCK_AGENTS_DIR = path.join(os.homedir(), ".agents");
const AUTH_JSON_PATH = path.join(MOCK_AGENTS_DIR, "agent-credentials.json");

describe("auth-resolver", () => {
	let originalAuthContent: string | null = null;

	beforeAll(() => {
		fs.mkdirSync(MOCK_AGENTS_DIR, { recursive: true });
		if (fs.existsSync(AUTH_JSON_PATH)) {
			originalAuthContent = fs.readFileSync(AUTH_JSON_PATH, "utf-8");
		}
	});
	afterAll(() => {
		try {
			if (originalAuthContent !== null) {
				fs.writeFileSync(AUTH_JSON_PATH, originalAuthContent, "utf-8");
			} else {
				fs.unlinkSync(AUTH_JSON_PATH);
			}
		} catch {}
	});

	test("U-AR-01 | Returns token from ENV if defined", async () => {
		process.env.TESTPROV_API_KEY = "env-token-123";
		const token = await resolveAuthToken("testprov");
		expect(token).toBe("env-token-123");
		delete process.env.TESTPROV_API_KEY;
	});

	test("U-AR-02 | Returns token from agent-credentials.json via command execution", async () => {
		fs.writeFileSync(
			AUTH_JSON_PATH,
			JSON.stringify({ testprov: "echo static-token-456" }),
		);
		const token = await resolveAuthToken("testprov");
		expect(token).toBe("static-token-456");
	});

	test("U-AR-03 | Returns token from dynamic execution (command)", async () => {
		// use echo to simulate a CLI tool printing the token
		fs.writeFileSync(
			AUTH_JSON_PATH,
			JSON.stringify({ testprov: "echo dynamic-token-789" }),
		);
		const token = await resolveAuthToken("testprov");
		expect(token).toBe("dynamic-token-789");
	});

	test("U-AR-04 | Throws if provider absent from ENV and agent-credentials.json", async () => {
		fs.writeFileSync(
			AUTH_JSON_PATH,
			JSON.stringify({ otherprov: "echo static-token" }),
		);
		await expect(resolveAuthToken("testprov")).rejects.toThrow(
			"not found in env or agent-credentials.json",
		);
	});

	test("U-AR-05 | Throws an error if dynamic command fails (enforces command strictness)", async () => {
		fs.writeFileSync(
			AUTH_JSON_PATH,
			JSON.stringify({ testprov: "sk-static-token-that-is-not-a-command" }),
		);
		await expect(resolveAuthToken("testprov")).rejects.toThrow(
			"Failed to execute credential command",
		);
	});

	test("U-AR-06 | Dynamic command ignores stderr, returns only stdout", async () => {
		// sh -c 'echo "token" && echo "warning" >&2'
		fs.writeFileSync(
			AUTH_JSON_PATH,
			JSON.stringify({ testprov: "sh -c 'echo dyn-token && echo noise >&2'" }),
		);
		const token = await resolveAuthToken("testprov");
		expect(token).toBe("dyn-token"); // The stderr noise should not be captured
	});

	test("U-AR-07 | Token is trimmed of whitespace", async () => {
		fs.writeFileSync(
			AUTH_JSON_PATH,
			JSON.stringify({ testprov: "echo '  padded-token  \n'" }),
		);
		const token = await resolveAuthToken("testprov");
		expect(token).toBe("padded-token");
	});
});
