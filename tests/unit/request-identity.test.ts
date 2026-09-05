import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { resolveRequestIdentity } from "../../src/modules/orders/request-identity.ts";
import { REQUEST_ENV_KEYS } from "../../src/modules/orders/types.ts";

const managedKeys = [
	"ANTIGRAVITY_AGENT",
	"ANTIGRAVITY_TRAJECTORY_ID",
	"CLAUDE_CODE",
	"CODEX_THREAD_ID",
	"PI_AGENT",
	"PI_SESSION_ID",
	"NODE_ENV",
	"USER",
	REQUEST_ENV_KEYS.requestId,
	REQUEST_ENV_KEYS.originSessionId,
	REQUEST_ENV_KEYS.originAgent,
	REQUEST_ENV_KEYS.callerName,
] as const;
const originalEnvironment = new Map(
	managedKeys.map((key) => [key, process.env[key]] as const),
);

function clearIdentityEnvironment(): void {
	for (const key of managedKeys) delete process.env[key];
}

afterEach(() => {
	clearIdentityEnvironment();
	for (const [key, value] of originalEnvironment) {
		if (value !== undefined) process.env[key] = value;
	}
});

describe("request identity detection", () => {
	test("recognizes Codex as the request origin and exports its session", () => {
		clearIdentityEnvironment();
		process.env.CODEX_THREAD_ID = "codex-thread";

		const identity = resolveRequestIdentity();

		assert.strictEqual(identity.originAgent, "codex");
		assert.strictEqual(identity.callerName, "Codex");
		assert.strictEqual(identity.originSessionId, "codex-thread");
		assert.strictEqual(
			process.env[REQUEST_ENV_KEYS.originSessionId],
			"codex-thread",
		);
	});

	test("recognizes Claude Code without inventing a session identifier", () => {
		clearIdentityEnvironment();
		process.env.CLAUDE_CODE = "1";

		const identity = resolveRequestIdentity();

		assert.strictEqual(identity.originAgent, "claude");
		assert.strictEqual(identity.callerName, "Claude Code");
		assert.strictEqual(identity.originSessionId, undefined);
	});

	test("rejects empty explicit caller and origin identities", () => {
		for (const key of [
			REQUEST_ENV_KEYS.callerName,
			REQUEST_ENV_KEYS.originAgent,
		]) {
			clearIdentityEnvironment();
			process.env.USER = "test-user";
			process.env[key] = "   ";
			assert.throws(() => resolveRequestIdentity(), /must not be empty/u);
		}
	});

	test("uses an explicit CLI identity when no agent harness is active", () => {
		clearIdentityEnvironment();
		process.env.USER = "test-user";

		const identity = resolveRequestIdentity();

		assert.strictEqual(identity.originAgent, "cli");
		assert.strictEqual(identity.callerName, "test-user");
	});
});
