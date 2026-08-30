// tests/unit/auth-resolver.test.ts — Unit tests for src/modules/auth-resolver.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { resolveAuthToken } from "../../src/modules/core/auth-resolver.ts";

const MOCK_AGENTS_DIR = path.join(os.homedir(), ".agents");
const AUTH_JSON_PATH = path.join(MOCK_AGENTS_DIR, "agent-credentials.json");

describe("auth-resolver", () => {
	let originalAuthContent: string | null = null;

	before(() => {
		fs.mkdirSync(MOCK_AGENTS_DIR, { recursive: true });
		if (fs.existsSync(AUTH_JSON_PATH)) {
			originalAuthContent = fs.readFileSync(AUTH_JSON_PATH, "utf-8");
		}
	});
	after(() => {
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
		assert.strictEqual(token, "env-token-123");
		delete process.env.TESTPROV_API_KEY;
	});

	test("U-AR-02 | Returns token from agent-credentials.json via command execution", async () => {
		fs.writeFileSync(
			AUTH_JSON_PATH,
			JSON.stringify({ testprov: "echo static-token-456" }),
		);
		const token = await resolveAuthToken("testprov");
		assert.strictEqual(token, "static-token-456");
	});

	test("U-AR-03 | Returns token from dynamic execution (command)", async () => {
		// use echo to simulate a CLI tool printing the token
		fs.writeFileSync(
			AUTH_JSON_PATH,
			JSON.stringify({ testprov: "echo dynamic-token-789" }),
		);
		const token = await resolveAuthToken("testprov");
		assert.strictEqual(token, "dynamic-token-789");
	});

	test("U-AR-04 | Throws if provider absent from ENV and agent-credentials.json", async () => {
		fs.writeFileSync(
			AUTH_JSON_PATH,
			JSON.stringify({ otherprov: "echo static-token" }),
		);
		await assert.rejects(
			resolveAuthToken("testprov"),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes("not found in env or agent-credentials.json"),
		);
	});

	test("U-AR-05 | Throws an error if dynamic command fails (enforces command strictness)", async () => {
		fs.writeFileSync(
			AUTH_JSON_PATH,
			JSON.stringify({ testprov: "sk-static-token-that-is-not-a-command" }),
		);
		await assert.rejects(
			resolveAuthToken("testprov"),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes("Failed to execute credential command"),
		);
	});

	test("U-AR-06 | Dynamic command ignores stderr, returns only stdout", async () => {
		// sh -c 'echo "token" && echo "warning" >&2'
		fs.writeFileSync(
			AUTH_JSON_PATH,
			JSON.stringify({ testprov: "sh -c 'echo dyn-token && echo noise >&2'" }),
		);
		const token = await resolveAuthToken("testprov");
		assert.strictEqual(token, "dyn-token"); // The stderr noise should not be captured
	});

	test("U-AR-07 | Token is trimmed of whitespace", async () => {
		fs.writeFileSync(
			AUTH_JSON_PATH,
			JSON.stringify({ testprov: "echo '  padded-token  \n'" }),
		);
		const token = await resolveAuthToken("testprov");
		assert.strictEqual(token, "padded-token");
	});

	test("U-AR-08 | Nested lookup: resolves token via agent in nested provider map", async () => {
		fs.writeFileSync(
			AUTH_JSON_PATH,
			JSON.stringify({
				testprov: {
					janet: "echo janet-token",
					marcus: "echo marcus-token",
				},
			}),
		);
		const token = await resolveAuthToken("testprov", "janet");
		assert.strictEqual(token, "janet-token");
	});

	test("U-AR-09 | Nested lookup: second agent returns its own token", async () => {
		fs.writeFileSync(
			AUTH_JSON_PATH,
			JSON.stringify({
				testprov: {
					janet: "echo janet-token",
					marcus: "echo marcus-token",
				},
			}),
		);
		const token = await resolveAuthToken("testprov", "marcus");
		assert.strictEqual(token, "marcus-token");
	});

	test("U-AR-10 | Nested lookup: absent agent throws descriptive error", async () => {
		fs.writeFileSync(
			AUTH_JSON_PATH,
			JSON.stringify({
				testprov: {
					janet: "echo janet-token",
				},
			}),
		);
		await assert.rejects(
			resolveAuthToken("testprov", "unknown-agent"),
			(error: unknown) =>
				error instanceof Error && error.message.includes("not found"),
		);
	});

	test("U-AR-11 | Flat provider (has 'key') ignores agent and resolves normally (backward compat)", async () => {
		fs.writeFileSync(
			AUTH_JSON_PATH,
			JSON.stringify({ testprov: "echo flat-token" }),
		);
		// Even with agent provided, flat format takes precedence
		const token = await resolveAuthToken("testprov", "some-agent");
		assert.strictEqual(token, "flat-token");
	});

	test("U-AR-12 | Nested lookup without agent: falls back to flat behavior if provider is nested", async () => {
		// When agent is omitted but provider is a nested map (no 'key'),
		// the nested map itself is treated as the tokenConfig — malformed.
		fs.writeFileSync(
			AUTH_JSON_PATH,
			JSON.stringify({
				testprov: {
					janet: "echo janet-token",
				},
			}),
		);
		await assert.rejects(
			resolveAuthToken("testprov"),
			(error: unknown) =>
				error instanceof Error && error.message.includes("malformed"),
		);
	});
});
