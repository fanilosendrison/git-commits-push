import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyTransient } from "../../src/modules/git/push.ts";
import { sanitizePushDiagnostic } from "../../src/modules/git/push-diagnostic-sanitizer.ts";

describe("push diagnostic sanitization", () => {
	test("retains protected-branch diagnostics while removing credentials", () => {
		const diagnostic = [
			"remote: GH006 protected branch",
			"https://oauth2:authority-secret@example.test/repo.git?token=query-secret",
			"Authorization: Bearer bearer-secret",
		].join(" ");
		const sanitized = sanitizePushDiagnostic(diagnostic);

		assert.match(sanitized, /GH006 protected branch/u);
		for (const secret of [
			"authority-secret",
			"query-secret",
			"bearer-secret",
		]) {
			assert.ok(!sanitized.includes(secret));
		}
		assert.strictEqual(classifyTransient(sanitized), false);
	});

	test("redacts supported URL userinfo across Git transport schemes", () => {
		for (const url of [
			"https://user:https-secret@example.test/repo.git",
			"ssh://user:ssh-secret@example.test/repo.git",
			"git+https://user:git-secret@example.test/repo.git",
		]) {
			const sanitized = sanitizePushDiagnostic(`fatal: ${url}`);
			assert.match(sanitized, /<redacted>@example\.test/u);
			assert.ok(!sanitized.includes("-secret"));
		}
	});

	test("redacts sensitive query parameters without removing safe context", () => {
		const keys = [
			"access_token",
			"oauth_token",
			"client_secret",
			"private_token",
			"api-key",
			"api_key",
			"x-api-key",
			"X-Amz-Credential",
			"X-Amz-Signature",
			"X-Amz-Security-Token",
		];
		const query = keys.map((key, index) => `${key}=secret-${index}`).join("&");
		const sanitized = sanitizePushDiagnostic(
			`remote: rejected https://example.test/repo.git?${query}&safe=value`,
		);

		for (let index = 0; index < keys.length; index++) {
			assert.ok(!sanitized.includes(`secret-${index}`));
		}
		assert.match(sanitized, /safe=value/u);
		assert.match(sanitized, /remote: rejected/u);
	});

	test("redacts credentials rendered in URL fragments", () => {
		const sanitized = sanitizePushDiagnostic(
			"fatal: https://example.test/repo.git#access_token=fragment-secret",
		);
		assert.ok(!sanitized.includes("fragment-secret"));
		assert.match(sanitized, /#access_token=<redacted>/u);
	});

	test("redacts complete structured authorization headers", () => {
		const diagnostic = [
			'Authorization: Digest username="alice", response="digest-secret"',
			"Authorization: AWS4-HMAC-SHA256 Credential=aws-secret, SignedHeaders=host, Signature=sig-secret",
			"remote: protected branch",
		].join("\n");
		const sanitized = sanitizePushDiagnostic(diagnostic);

		for (const secret of [
			"alice",
			"digest-secret",
			"aws-secret",
			"sig-secret",
		]) {
			assert.ok(!sanitized.includes(secret));
		}
		assert.strictEqual(sanitized.split("\n")[0], "Authorization: <redacted>");
		assert.strictEqual(sanitized.split("\n")[1], "Authorization: <redacted>");
		assert.match(sanitized, /remote: protected branch/u);
	});

	test("keeps complete SSH DNS failures transient", () => {
		const diagnostic = [
			"ssh: Could not resolve hostname example.invalid: nodename nor servname provided",
			"fatal: Could not read from remote repository.",
		].join("\n");
		assert.strictEqual(classifyTransient(diagnostic), true);
	});

	test("redacts authorization and token headers case-insensitively", () => {
		const diagnostic = [
			"Authorization: Basic basic-secret",
			"authorization: bearer bearer-secret",
			"PRIVATE-TOKEN: private-secret",
			"Job-Token: job-secret",
			"X-API-Key: api-secret",
		].join("\n");
		const sanitized = sanitizePushDiagnostic(diagnostic);

		for (const secret of [
			"basic-secret",
			"bearer-secret",
			"private-secret",
			"job-secret",
			"api-secret",
		]) {
			assert.ok(!sanitized.includes(secret));
		}
	});
});
