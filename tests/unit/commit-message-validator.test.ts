/**
 * Unit tests for commit-message-validator module.
 *
 * Covers all 8 validation rules plus multi-line (body) support.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { validateCommitMessage } from "../../src/modules/core/validators/commit-message-validator.ts";

// ─── Valid messages ──────────────────────────────────────────────────────

describe("valid messages", () => {
	test("accepts basic type: description", () => {
		const r = validateCommitMessage("feat: add new feature");
		assert.strictEqual(r.valid, true);
		assert.deepStrictEqual(r.errors, []);
	});

	test("accepts type(scope): description", () => {
		const r = validateCommitMessage("fix(api): handle edge case");
		assert.strictEqual(r.valid, true);
	});

	test("accepts breaking change with !", () => {
		const r = validateCommitMessage("feat!: breaking change");
		assert.strictEqual(r.valid, true);
	});

	test("accepts type(scope)!: description", () => {
		const r = validateCommitMessage("refactor(core)!: complete rewrite");
		assert.strictEqual(r.valid, true);
	});

	test("accepts all VALID_TYPES", () => {
		for (const type of [
			"feat",
			"fix",
			"docs",
			"style",
			"refactor",
			"perf",
			"test",
			"build",
			"ci",
			"chore",
			"revert",
		]) {
			const r = validateCommitMessage(`${type}: message`);
			assert.strictEqual(r.valid, true);
		}
	});
});

// ─── Multi-line messages with body — the fix ─────────────────────────────

describe("multi-line messages (body support)", () => {
	test("accepts subject + body separated by blank line", () => {
		const r = validateCommitMessage(
			"feat: add login\n\nImplement OAuth2 login flow\n- Token refresh\n- Session management",
		);
		assert.strictEqual(r.valid, true);
	});

	test("accepts subject + body + trailing newlines", () => {
		const r = validateCommitMessage(
			"fix(api): correct status code\n\nReturn 404 instead of 500\n\nCloses #42\n",
		);
		assert.strictEqual(r.valid, true);
	});

	test("rejects invalid subject even with valid body", () => {
		const r = validateCommitMessage(
			"InvalidMsg: stuff\n\nBody is fine but subject is wrong type",
		);
		assert.strictEqual(r.valid, false);
		assert.strictEqual(
			r.errors.some((e) => e.includes("Types autorisés")),
			true,
		);
	});
});

// ─── Format errors ───────────────────────────────────────────────────────

describe("format errors", () => {
	test("rejects message without colon separator", () => {
		const r = validateCommitMessage("feat add feature");
		assert.strictEqual(r.valid, false);
		assert.deepStrictEqual(r.errors, [
			"Format invalide. Attendu: <type>(<scope>): <description>",
		]);
	});

	test("rejects empty message", () => {
		const r = validateCommitMessage("");
		assert.strictEqual(r.valid, false);
		assert.deepStrictEqual(r.errors, ["Message de commit vide"]);
	});

	test("rejects whitespace-only message", () => {
		const r = validateCommitMessage("   \n  ");
		assert.strictEqual(r.valid, false);
		assert.deepStrictEqual(r.errors, ["Message de commit vide"]);
	});

	test("rejects message without type", () => {
		const r = validateCommitMessage(": missing type");
		assert.strictEqual(r.valid, false);
		assert.deepStrictEqual(r.errors, [
			"Format invalide. Attendu: <type>(<scope>): <description>",
		]);
	});
});

// ─── Invalid type ────────────────────────────────────────────────────────

describe("invalid type", () => {
	test("rejects unknown type", () => {
		const r = validateCommitMessage("edit: stuff");
		assert.strictEqual(r.valid, false);
		assert.strictEqual(
			r.errors.some((e) => e.includes('Type "edit"')),
			true,
		);
	});

	test("rejects wip type", () => {
		const r = validateCommitMessage("wip: in progress");
		assert.strictEqual(r.valid, false);
		assert.strictEqual(
			r.errors.some((e) => e.includes("Types autorisés")),
			true,
		);
	});
});

// ─── Capitalized description ─────────────────────────────────────────────

describe("capitalized description", () => {
	test("rejects capital first letter after colon", () => {
		const r = validateCommitMessage("feat: Add new feature");
		assert.strictEqual(r.valid, false);
		assert.strictEqual(
			r.errors.some((e) => e.includes("majuscule")),
			true,
		);
	});
});

// ─── Trailing period ─────────────────────────────────────────────────────

describe("trailing period", () => {
	test("rejects description ending with dot", () => {
		const r = validateCommitMessage("feat: add feature.");
		assert.strictEqual(r.valid, false);
		assert.strictEqual(
			r.errors.some((e) => e.includes("point")),
			true,
		);
	});
});

// ─── Subject line too long ───────────────────────────────────────────────

describe("subject line too long", () => {
	test("rejects subject exceeding 72 chars", () => {
		const longSubject = `feat: ${"x".repeat(70)}`;
		assert.ok(longSubject.length > 72);
		const r = validateCommitMessage(longSubject);
		assert.strictEqual(r.valid, false);
		assert.strictEqual(
			r.errors.some((e) => e.includes("trop long")),
			true,
		);
	});

	test("accepts subject of exactly 72 chars", () => {
		const msg = `feat: ${"x".repeat(66)}`;
		assert.strictEqual(msg.length, 72);
		const r = validateCommitMessage(msg);
		assert.strictEqual(r.valid, true);
	});

	test("checks subject line only, not body length", () => {
		const msg = `feat: short subject\n\n${"x".repeat(200)}\n${"y".repeat(300)}`;
		const r = validateCommitMessage(msg);
		assert.strictEqual(r.valid, true); // body can be any length
	});
});

// ─── Past tense ──────────────────────────────────────────────────────────

describe("past tense", () => {
	test("rejects added", () => {
		const r = validateCommitMessage("feat: added new endpoint");
		assert.strictEqual(r.valid, false);
		assert.strictEqual(
			r.errors.some((e) => e.includes("pas le passé")),
			true,
		);
	});

	test("rejects fixed", () => {
		const r = validateCommitMessage("fix: fixed the bug");
		assert.strictEqual(r.valid, false);
	});

	test("rejects removed, updated, changed, deleted", () => {
		for (const past of ["removed", "updated", "changed", "deleted"]) {
			const r = validateCommitMessage(`feat: ${past} stuff`);
			assert.strictEqual(r.valid, false);
		}
	});

	test("accepts imperative present", () => {
		const r = validateCommitMessage("feat: add new endpoint");
		assert.strictEqual(r.valid, true);
	});
});

// ─── Gerund ──────────────────────────────────────────────────────────────

describe("gerund", () => {
	test("rejects adding", () => {
		const r = validateCommitMessage("feat: adding new endpoint");
		assert.strictEqual(r.valid, false);
		assert.strictEqual(
			r.errors.some((e) => e.includes("pas le gérondif")),
			true,
		);
	});

	test("rejects fixing, removing, updating", () => {
		for (const g of ["fixing", "removing", "updating"]) {
			const r = validateCommitMessage(`feat: ${g} stuff`);
			assert.strictEqual(r.valid, false);
		}
	});
});

// ─── Vague description ───────────────────────────────────────────────────

describe("vague description", () => {
	// biome-ignore format: retain the JSON-quoted historical parity case name.
	test("rejects \"stuff\"", () => {
		const r = validateCommitMessage("feat: stuff");
		assert.strictEqual(r.valid, false);
		assert.strictEqual(
			r.errors.some((e) => e.includes("vague")),
			true,
		);
	});

	// biome-ignore format: retain the JSON-quoted historical parity case name.
	test("rejects \"wip\", \"temp\", \"changes\", \"misc\"", () => {
		for (const v of ["wip", "temp", "changes", "misc"]) {
			const r = validateCommitMessage(`fix: ${v}`);
			assert.strictEqual(r.valid, false);
		}
	});

	// biome-ignore format: retain the JSON-quoted historical parity case name.
	test("rejects \"fix bug\"", () => {
		const r = validateCommitMessage("fix: fix bug");
		assert.strictEqual(r.valid, false);
	});
});

// ─── Combined errors ────────────────────────────────────────────────────

describe("combined errors", () => {
	test("accumulates multiple errors", () => {
		const r = validateCommitMessage("edit: Added fix bug.");
		assert.strictEqual(r.valid, false);
		// Should have: invalid_type + capitalized + past_tense + vague + period
		assert.ok(r.errors.length >= 4);
	});
});
