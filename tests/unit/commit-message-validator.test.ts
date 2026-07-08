/**
 * Unit tests for commit-message-validator module.
 *
 * Covers all 8 validation rules plus multi-line (body) support.
 */

import { describe, expect, test } from "bun:test";
import { validateCommitMessage } from "../../src/modules/core/validators/commit-message-validator";

// ─── Valid messages ──────────────────────────────────────────────────────

describe("valid messages", () => {
	test("accepts basic type: description", () => {
		const r = validateCommitMessage("feat: add new feature");
		expect(r.valid).toBe(true);
		expect(r.errors).toEqual([]);
	});

	test("accepts type(scope): description", () => {
		const r = validateCommitMessage("fix(api): handle edge case");
		expect(r.valid).toBe(true);
	});

	test("accepts breaking change with !", () => {
		const r = validateCommitMessage("feat!: breaking change");
		expect(r.valid).toBe(true);
	});

	test("accepts type(scope)!: description", () => {
		const r = validateCommitMessage("refactor(core)!: complete rewrite");
		expect(r.valid).toBe(true);
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
			expect(r.valid).toBe(true);
		}
	});
});

// ─── Multi-line messages with body — the fix ─────────────────────────────

describe("multi-line messages (body support)", () => {
	test("accepts subject + body separated by blank line", () => {
		const r = validateCommitMessage(
			"feat: add login\n\nImplement OAuth2 login flow\n- Token refresh\n- Session management",
		);
		expect(r.valid).toBe(true);
	});

	test("accepts subject + body + trailing newlines", () => {
		const r = validateCommitMessage(
			"fix(api): correct status code\n\nReturn 404 instead of 500\n\nCloses #42\n",
		);
		expect(r.valid).toBe(true);
	});

	test("rejects invalid subject even with valid body", () => {
		const r = validateCommitMessage(
			"InvalidMsg: stuff\n\nBody is fine but subject is wrong type",
		);
		expect(r.valid).toBe(false);
		expect(r.errors.some((e) => e.includes("Types autorisés"))).toBe(true);
	});
});

// ─── Format errors ───────────────────────────────────────────────────────

describe("format errors", () => {
	test("rejects message without colon separator", () => {
		const r = validateCommitMessage("feat add feature");
		expect(r.valid).toBe(false);
		expect(r.errors).toEqual([
			"Format invalide. Attendu: <type>(<scope>): <description>",
		]);
	});

	test("rejects empty message", () => {
		const r = validateCommitMessage("");
		expect(r.valid).toBe(false);
		expect(r.errors).toEqual(["Message de commit vide"]);
	});

	test("rejects whitespace-only message", () => {
		const r = validateCommitMessage("   \n  ");
		expect(r.valid).toBe(false);
		expect(r.errors).toEqual(["Message de commit vide"]);
	});

	test("rejects message without type", () => {
		const r = validateCommitMessage(": missing type");
		expect(r.valid).toBe(false);
		expect(r.errors).toEqual([
			"Format invalide. Attendu: <type>(<scope>): <description>",
		]);
	});
});

// ─── Invalid type ────────────────────────────────────────────────────────

describe("invalid type", () => {
	test("rejects unknown type", () => {
		const r = validateCommitMessage("edit: stuff");
		expect(r.valid).toBe(false);
		expect(r.errors.some((e) => e.includes('Type "edit"'))).toBe(true);
	});

	test("rejects wip type", () => {
		const r = validateCommitMessage("wip: in progress");
		expect(r.valid).toBe(false);
		expect(r.errors.some((e) => e.includes("Types autorisés"))).toBe(true);
	});
});

// ─── Capitalized description ─────────────────────────────────────────────

describe("capitalized description", () => {
	test("rejects capital first letter after colon", () => {
		const r = validateCommitMessage("feat: Add new feature");
		expect(r.valid).toBe(false);
		expect(r.errors.some((e) => e.includes("majuscule"))).toBe(true);
	});
});

// ─── Trailing period ─────────────────────────────────────────────────────

describe("trailing period", () => {
	test("rejects description ending with dot", () => {
		const r = validateCommitMessage("feat: add feature.");
		expect(r.valid).toBe(false);
		expect(r.errors.some((e) => e.includes("point"))).toBe(true);
	});
});

// ─── Subject line too long ───────────────────────────────────────────────

describe("subject line too long", () => {
	test("rejects subject exceeding 72 chars", () => {
		const longSubject = `feat: ${"x".repeat(70)}`;
		expect(longSubject.length).toBeGreaterThan(72);
		const r = validateCommitMessage(longSubject);
		expect(r.valid).toBe(false);
		expect(r.errors.some((e) => e.includes("trop long"))).toBe(true);
	});

	test("accepts subject of exactly 72 chars", () => {
		const msg = `feat: ${"x".repeat(66)}`;
		expect(msg.length).toBe(72);
		const r = validateCommitMessage(msg);
		expect(r.valid).toBe(true);
	});

	test("checks subject line only, not body length", () => {
		const msg = `feat: short subject\n\n${"x".repeat(200)}\n${"y".repeat(300)}`;
		const r = validateCommitMessage(msg);
		expect(r.valid).toBe(true); // body can be any length
	});
});

// ─── Past tense ──────────────────────────────────────────────────────────

describe("past tense", () => {
	test("rejects added", () => {
		const r = validateCommitMessage("feat: added new endpoint");
		expect(r.valid).toBe(false);
		expect(r.errors.some((e) => e.includes("pas le passé"))).toBe(true);
	});

	test("rejects fixed", () => {
		const r = validateCommitMessage("fix: fixed the bug");
		expect(r.valid).toBe(false);
	});

	test("rejects removed, updated, changed, deleted", () => {
		for (const past of ["removed", "updated", "changed", "deleted"]) {
			const r = validateCommitMessage(`feat: ${past} stuff`);
			expect(r.valid).toBe(false);
		}
	});

	test("accepts imperative present", () => {
		const r = validateCommitMessage("feat: add new endpoint");
		expect(r.valid).toBe(true);
	});
});

// ─── Gerund ──────────────────────────────────────────────────────────────

describe("gerund", () => {
	test("rejects adding", () => {
		const r = validateCommitMessage("feat: adding new endpoint");
		expect(r.valid).toBe(false);
		expect(r.errors.some((e) => e.includes("pas le gérondif"))).toBe(true);
	});

	test("rejects fixing, removing, updating", () => {
		for (const g of ["fixing", "removing", "updating"]) {
			const r = validateCommitMessage(`feat: ${g} stuff`);
			expect(r.valid).toBe(false);
		}
	});
});

// ─── Vague description ───────────────────────────────────────────────────

describe("vague description", () => {
	test('rejects "stuff"', () => {
		const r = validateCommitMessage("feat: stuff");
		expect(r.valid).toBe(false);
		expect(r.errors.some((e) => e.includes("vague"))).toBe(true);
	});

	test('rejects "wip", "temp", "changes", "misc"', () => {
		for (const v of ["wip", "temp", "changes", "misc"]) {
			const r = validateCommitMessage(`fix: ${v}`);
			expect(r.valid).toBe(false);
		}
	});

	test('rejects "fix bug"', () => {
		const r = validateCommitMessage("fix: fix bug");
		expect(r.valid).toBe(false);
	});
});

// ─── Combined errors ────────────────────────────────────────────────────

describe("combined errors", () => {
	test("accumulates multiple errors", () => {
		const r = validateCommitMessage("edit: Added fix bug.");
		expect(r.valid).toBe(false);
		// Should have: invalid_type + capitalized + past_tense + vague + period
		expect(r.errors.length).toBeGreaterThanOrEqual(4);
	});
});
