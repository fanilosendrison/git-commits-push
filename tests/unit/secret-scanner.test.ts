import { describe, expect, test } from "bun:test";
import { scanDiff } from "../../src/modules/core/secret-scanner";

describe("secret-scanner Core Unit Tests", () => {
	test("empty diff is clean", () => {
		expect(scanDiff("").clean).toBe(true);
		expect(scanDiff("   \n  ").clean).toBe(true);
	});

	test("diff without additions is clean", () => {
		const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
-old line
+new line without secrets`;
		expect(scanDiff(diff).clean).toBe(true);
	});

	test("normal code additions are clean", () => {
		const diff = `+const x = 1;
+function hello() {
+  return "world";
+}`;
		expect(scanDiff(diff).clean).toBe(true);
	});

	test("detects AWS access key", () => {
		const diff = "+AKIA1234567890ABCDEF";
		const r = scanDiff(diff);
		expect(r.clean).toBe(false);
		expect(r.findings.some((f) => f.name === "AWS Access Key")).toBe(true);
	});

	test("detects GitHub token", () => {
		const diff = "+ghp_1234567890abcdefghijklmnopqrstuvwxyz";
		const r = scanDiff(diff);
		expect(r.clean).toBe(false);
		expect(r.findings.some((f) => f.name === "GitHub Token")).toBe(true);
	});

	test("detects private key block", () => {
		const diff = "+-----BEGIN PRIVATE KEY-----";
		const r = scanDiff(diff);
		expect(r.clean).toBe(false);
		expect(r.findings.some((f) => f.name === "Private Key")).toBe(true);
	});

	test("detects connection strings with credentials", () => {
		const diff = "+mongodb://user:password@localhost:27017/db";
		const r = scanDiff(diff);
		expect(r.clean).toBe(false);
		expect(r.findings.some((f) => f.name === "Connection String")).toBe(true);
	});

	test("detects generic API key", () => {
		const diff = '+api_key: "abcdefghijklmnopqrstuvwxyz123456"';
		const r = scanDiff(diff);
		expect(r.clean).toBe(false);
		expect(r.findings.some((f) => f.name === "Generic API Key")).toBe(true);
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
			expect(r.clean).toBe(true);
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
			expect(r.clean).toBe(true);
		}
	});

	test("ignores short password-like values", () => {
		expect(scanDiff("+password=abc").clean).toBe(true);
		expect(scanDiff("+password=1234567").clean).toBe(true);
	});

	test("detects real-looking password assignments", () => {
		expect(scanDiff("+password=MyS3cur3P@ssw0rd!").clean).toBe(false);
		expect(scanDiff("+DB_PASSWORD=super_secret_12345").clean).toBe(false);
	});

	test("detects Slack tokens", () => {
		expect(scanDiff("+xoxb-1234567890-abcdefghijklmnop").clean).toBe(false);
	});

	test("tracks line numbers", () => {
		const diff = ` line 1
+AKIA1234567890ABCDEF
 line 3`;
		const r = scanDiff(diff);
		expect(r.findings[0]?.lineNumber).toBe(2);
	});

	test("warns without blocking for secrets in non-production paths", () => {
		const diff = `diff --git a/tests/secrets.test.ts b/tests/secrets.test.ts
--- a/tests/secrets.test.ts
+++ b/tests/secrets.test.ts
@@ -0,0 +1 @@
+const api_key = "abcdefghijklmnopqrstuvwxyz123456";`;
		const r = scanDiff(diff);
		expect(r.clean).toBe(true);
		expect(r.findings).toHaveLength(0);
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]?.filePath).toBe("tests/secrets.test.ts");
		expect(r.warnings[0]?.reason).toBe("non-production path");
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
		expect(r.clean).toBe(false);
		expect(r.warnings).toHaveLength(1);
		expect(r.findings).toHaveLength(1);
		expect(r.warnings[0]?.filePath).toBe("tests/mock.ts");
		expect(r.findings[0]?.filePath).toBe("src/config.ts");
	});

	test("skips secrets in environment example files", () => {
		for (const filename of [".env.example", ".env.template", ".env.sample"]) {
			const diff = `diff --git a/${filename} b/${filename}
--- a/${filename}
+++ b/${filename}
@@ -0,0 +1 @@
+OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz123456`;
			const r = scanDiff(diff);
			expect(r.clean).toBe(true);
			expect(r.findings).toHaveLength(0);
			expect(r.warnings).toHaveLength(0);
		}
	});

	test("skips secrets with an inline allow annotation", () => {
		const diff =
			'+const API_KEY = "abcdefghijklmnopqrstuvwxyz123456"; // git-commits-push: allow-secret';
		const r = scanDiff(diff);
		expect(r.clean).toBe(true);
		expect(r.findings).toHaveLength(0);
		expect(r.warnings).toHaveLength(0);
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
			expect(r.clean).toBe(true);
			expect(r.findings).toHaveLength(0);
			expect(r.warnings).toHaveLength(0);
		}
	});
});
