/**
 * Commit message validator — adapted from the former commit-msg-validator core.
 *
 * Validates commit messages against Conventional Commits 1.0.0 rules.
 * Now self-contained in the skill (no external dependency).
 */

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

const VALID_TYPES = [
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
] as const;

// type(scope)!: description
const COMMIT_MSG_REGEX = /^(\w+)(?:\(([^)]+)\))?(!)?\s*:\s(.+)$/;

const PAST_TENSE_PATTERN =
	/^(added|fixed|removed|updated|changed|deleted|created|modified|moved|renamed|resolved|refactored|implemented|improved)\b/i;

const GERUND_PATTERN =
	/^(adding|fixing|removing|updating|changing|deleting|creating|modifying|moving|renaming|resolving|refactoring|implementing|improving)\b/i;

const VAGUE_DESCRIPTIONS = [
	"fix bug",
	"fix bugs",
	"bug fix",
	"bugfix",
	"updates",
	"update",
	"stuff",
	"things",
	"changes",
	"change",
	"wip",
	"temp",
	"misc",
	"minor",
];

export function validateCommitMessage(message: string): ValidationResult {
	const trimmed = message.trim();
	if (!trimmed) {
		return { valid: false, errors: ["Message de commit vide"] };
	}

	// Extract first line (subject) for format validation — body is free-form
	const subject = trimmed.split("\n")[0]!.trim();

	const errors: string[] = [];

	const match = subject.match(COMMIT_MSG_REGEX);
	if (!match) {
		return {
			valid: false,
			errors: ["Format invalide. Attendu: <type>(<scope>): <description>"],
		};
	}

	const type = match[1]!;
	const description = match[4]!;

	if (!VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) {
		errors.push(
			`Type "${type}" invalide. Types autorisés: ${VALID_TYPES.join(", ")}`,
		);
	}

	if (/^[A-Z]/.test(description)) {
		errors.push(
			"La description ne doit pas commencer par une majuscule après le deux-points",
		);
	}

	if (description.endsWith(".")) {
		errors.push("La description ne doit pas se terminer par un point");
	}

	if (subject.length > 72) {
		errors.push(`Subject line trop long: ${subject.length}/72 caractères max`);
	}

	if (PAST_TENSE_PATTERN.test(description)) {
		errors.push(
			"Utiliser l'impératif présent (add, fix, remove) — pas le passé (added, fixed, removed)",
		);
	}

	if (GERUND_PATTERN.test(description)) {
		errors.push(
			"Utiliser l'impératif présent (add, fix, remove) — pas le gérondif (adding, fixing, removing)",
		);
	}

	if (VAGUE_DESCRIPTIONS.includes(description.toLowerCase())) {
		errors.push(
			`Description trop vague: "${description}". Être spécifique sur ce qui a changé`,
		);
	}

	return { valid: errors.length === 0, errors };
}
