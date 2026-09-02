import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { scanDiff } from "../../src/modules/core/secret-scanner.ts";

describe("secret-scanner Core Unit Tests", () => {
	test("empty diff is clean", () => {
		assert.strictEqual(scanDiff("").clean, true);
		assert.strictEqual(scanDiff("   \n  ").clean, true);
	});

	test("diff without additions is clean", () => {
		const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
-old line
+new line without secrets`;
		assert.strictEqual(scanDiff(diff).clean, true);
	});

	test("normal code additions are clean", () => {
		const diff = `+const x = 1;
+function hello() {
+  return "world";
+}`;
		assert.strictEqual(scanDiff(diff).clean, true);
	});

	test("detects AWS access key", () => {
		const diff = "+AKIA1234567890ABCDEF";
		const r = scanDiff(diff);
		assert.strictEqual(r.clean, false);
		assert.strictEqual(
			r.findings.some((f) => f.name === "AWS Access Key"),
			true,
		);
	});

	test("detects GitHub token", () => {
		const diff = "+ghp_1234567890abcdefghijklmnopqrstuvwxyz";
		const r = scanDiff(diff);
		assert.strictEqual(r.clean, false);
		assert.strictEqual(
			r.findings.some((f) => f.name === "GitHub Token"),
			true,
		);
	});

	test("detects private key block", () => {
		const diff = "+-----BEGIN PRIVATE KEY-----";
		const r = scanDiff(diff);
		assert.strictEqual(r.clean, false);
		assert.strictEqual(
			r.findings.some((f) => f.name === "Private Key"),
			true,
		);
	});

	test("detects connection strings with credentials", () => {
		const diff = "+mongodb://user:password@localhost:27017/db";
		const r = scanDiff(diff);
		assert.strictEqual(r.clean, false);
		assert.strictEqual(
			r.findings.some((f) => f.name === "Connection String"),
			true,
		);
	});

	test("detects generic API key", () => {
		const diff = '+api_key: "abcdefghijklmnopqrstuvwxyz123456"';
		const r = scanDiff(diff);
		assert.strictEqual(r.clean, false);
		assert.strictEqual(
			r.findings.some((f) => f.name === "Generic API Key"),
			true,
		);
	});

	test("ignores additions with env var references", () => {
		const clean = [
			"+const key = process.env.API_KEY;",
			"+const secret = os.environ['SECRET'];",
			["+const token = `", "$", "{API_TOKEN}", "`;"].join(""),
			"+const pw = getenv('DB_PASS');",
			"+const key = requireEnv('MY_KEY');",
			"+const api = getApiKey();",
		];
		for (const line of clean) {
			const r = scanDiff(line);
			assert.strictEqual(r.clean, true);
		}
	});

	test("ignores placeholder passwords", () => {
		const placeholders = [
			"+password=changeme",
			"+password=password",
			"+password=placeholder",
			"+password=example",
			"+password=xxx",
			"+password=xxxxxxxx",
			"+password=todo",
			"+password=fixme",
		];
		for (const line of placeholders) {
			const r = scanDiff(line);
			assert.strictEqual(r.clean, true);
		}
	});

	test("ignores short password-like values", () => {
		assert.strictEqual(scanDiff("+password=abc").clean, true);
		assert.strictEqual(scanDiff("+password=1234567").clean, true);
	});

	test("detects real-looking password assignments", () => {
		assert.strictEqual(scanDiff("+password=MyS3cur3P@ssw0rd!").clean, false);
		assert.strictEqual(
			scanDiff("+DB_PASSWORD=super_secret_12345").clean,
			false,
		);
	});

	test("does not flag equality comparisons as password assignments", () => {
		const comparisons = [
			'+parsed.password === "" &&',
			"+if (user.password == candidate) {",
			"+const isValid = password === input;",
		];
		for (const line of comparisons) {
			assert.strictEqual(scanDiff(line).clean, true, line);
		}
	});

	test("detects Slack tokens", () => {
		assert.strictEqual(
			scanDiff("+xoxb-1234567890-abcdefghijklmnop").clean,
			false,
		);
	});

	test("tracks line numbers", () => {
		const diff = ` line 1
+AKIA1234567890ABCDEF
 line 3`;
		const r = scanDiff(diff);
		assert.strictEqual(r.findings[0]?.lineNumber, 2);
	});

	test("warns without blocking for secrets in non-production paths", () => {
		const diff = `diff --git a/tests/secrets.test.ts b/tests/secrets.test.ts
--- a/tests/secrets.test.ts
+++ b/tests/secrets.test.ts
@@ -0,0 +1 @@
+const api_key = "abcdefghijklmnopqrstuvwxyz123456";`;
		const r = scanDiff(diff);
		assert.strictEqual(r.clean, true);
		assert.strictEqual(r.findings.length, 0);
		assert.strictEqual(r.warnings.length, 1);
		assert.strictEqual(r.warnings[0]?.filePath, "tests/secrets.test.ts");
		assert.strictEqual(r.warnings[0]?.reason, "non-production path");
	});

	test("keeps file context scoped across multi-file diffs", () => {
		const diff = `diff --git a/tests/mock.ts b/tests/mock.ts
--- a/tests/mock.ts
+++ b/tests/mock.ts
@@ -0,0 +1 @@
+const api_key = "abcdefghijklmnopqrstuvwxyz123456";
diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -0,0 +1 @@
+const access_token = "abcdefghijklmnopqrstuvwxyz123456";`;
		const r = scanDiff(diff);
		assert.strictEqual(r.clean, false);
		assert.strictEqual(r.warnings.length, 1);
		assert.strictEqual(r.findings.length, 1);
		assert.strictEqual(r.warnings[0]?.filePath, "tests/mock.ts");
		assert.strictEqual(r.findings[0]?.filePath, "src/config.ts");
	});

	test("skips secrets in environment example files", () => {
		for (const filename of [".env.example", ".env.template", ".env.sample"]) {
			const diff = `diff --git a/${filename} b/${filename}
--- a/${filename}
+++ b/${filename}
@@ -0,0 +1 @@
+OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz123456`;
			const r = scanDiff(diff);
			assert.strictEqual(r.clean, true);
			assert.strictEqual(r.findings.length, 0);
			assert.strictEqual(r.warnings.length, 0);
		}
	});

	test("skips secrets with an inline allow annotation", () => {
		const diff =
			'+const API_KEY = "abcdefghijklmnopqrstuvwxyz123456"; // git-commits-push: allow-secret';
		const r = scanDiff(diff);
		assert.strictEqual(r.clean, true);
		assert.strictEqual(r.findings.length, 0);
		assert.strictEqual(r.warnings.length, 0);
	});

	test("skips obvious same-line mock, dummy, test, example, and fake values", () => {
		const lines = [
			'+const API_KEY = "sk-mock-abcdefghijklmnopqrstuvwxyz123456";',
			'+const API_KEY = "sk-dummy-abcdefghijklmnopqrstuvwxyz123456";',
			'+const API_KEY = "sk-test-abcdefghijklmnopqrstuvwxyz123456";',
			'+const API_KEY = "sk-example-abcdefghijklmnopqrstuvwxyz123456";',
			'+const API_KEY = "sk-fake-abcdefghijklmnopqrstuvwxyz123456";',
		];

		for (const line of lines) {
			const r = scanDiff(line);
			assert.strictEqual(r.clean, true);
			assert.strictEqual(r.findings.length, 0);
			assert.strictEqual(r.warnings.length, 0);
		}
	});
});
