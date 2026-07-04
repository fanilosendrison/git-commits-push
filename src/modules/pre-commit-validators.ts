/**
 * src/modules/validation.ts — Phase 2: Validation & Diff Extraction
 *
 * Implements NIB-M-VALIDATION §3.
 *
 * secret-scanner is an external dependency that does NOT exist in this
 * monorepo yet (DC-SECRET-SCANNER §0). To keep the module testable and
 * fail-closed by default, the scanner is injected as a parameter with a
 * strict default that throws if not provided in production.
 *
 * Integration note: the Turnlock orchestrator (turnlock-orchestrator.ts) must
 * instantiate this module with the real scanner once it is available.
 */

import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RepositoryInfo, Settings } from "../types.ts";

// ─── Secret Scanner Adapter ──────────────────────────────────────────────────

export interface ScanResult {
	hasSecrets: boolean;
	details?: string;
	matchCount: number;
}

export type SecretScanner = (diffContent: string) => Promise<ScanResult>;

/**
 * Default scanner used in production.
 * Dynamically imports the scanner from the agent-enforcers directory since
 * it is a standalone script, not an npm package.
 */
const defaultScanner: SecretScanner = async (
	diff: string,
): Promise<ScanResult> => {
	const scannerPath = path.resolve(
		__dirname,
		"../../../../agent-enforcers/secret-scanner/src/core/scanner.ts",
	);
	if (!fs.existsSync(scannerPath)) {
		throw new Error(
			`secret-scanner is not installed or not found at ${scannerPath}. ` +
				"Provide a custom scanner via the scanner parameter.",
		);
	}

	try {
		// Import the module dynamically (works in bun)
		// We use import() because the module might not be compiled
		const module = await import(scannerPath);
		const result = module.scanDiff(diff) as {
			clean: boolean;
			findings?: { name: string; lineNumber: number }[];
		};
		const details = result.findings
			?.map(
				(f: { name: string; lineNumber: number }) =>
					`${f.name} at line ${f.lineNumber}`,
			)
			.join(", ");
		return {
			hasSecrets: !result.clean,
			matchCount: result.findings?.length ?? 0,
			...(details ? { details } : {}),
		};
	} catch (err) {
		throw new Error(
			`Failed to execute secret-scanner at ${scannerPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
};

// ─── Test Runner Cascade ─────────────────────────────────────────────────────

/**
 * Run the test suite in a repository following the auto-discovery cascade
 * defined in NIB-M-VALIDATION §3 (STACK_EVAL.yaml → package.json → auto-detect).
 *
 * Throws if the test suite exits with a non-zero code.
 */
export async function runTestCascade(repoPath: string): Promise<void> {
	// 1. STACK_EVAL.yaml
	const stackEvalPath = path.join(repoPath, "STACK_EVAL.yaml");
	if (fs.existsSync(stackEvalPath)) {
		const raw = fs.readFileSync(stackEvalPath, "utf-8");
		// Minimal inline YAML read (key: value, no external YAML parser dependency)
		const match = raw.match(/test_runner:\s*["']?([^"'\n]+)["']?/);
		if (match) {
			const runner = match[1]?.trim();
			switch (runner) {
				case "vitest":
					execCwd("bun x vitest run", repoPath);
					return;
				case "pytest":
					execCwd("pytest", repoPath);
					return;
				case "bun test":
					execCwd("bun test", repoPath);
					return;
				case "none":
					return;
			}
		}
	}

	// 2. package.json test script
	const pkgPath = path.join(repoPath, "package.json");
	if (fs.existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
				scripts?: Record<string, string>;
			};
			if (pkg.scripts?.test) {
				if (
					fs.existsSync(path.join(repoPath, "bun.lock")) ||
					fs.existsSync(path.join(repoPath, "bun.lockb"))
				) {
					execCwd("bun run test", repoPath);
					return;
				}
				if (fs.existsSync(path.join(repoPath, "pnpm-lock.yaml"))) {
					execCwd("pnpm run test", repoPath);
					return;
				}
				if (fs.existsSync(path.join(repoPath, "yarn.lock"))) {
					execCwd("yarn run test", repoPath);
					return;
				}
				execCwd("npm run test", repoPath);
				return;
			}
		} catch {
			// Malformed package.json — fall through to auto-discovery
		}
	}

	// 3. Auto-discovery: bun test for *.test.ts files
	if (hasFilesMatching(repoPath, /\.(test|spec)\.(ts|js)$/)) {
		execCwd("bun test", repoPath);
		return;
	}

	// 4. Auto-discovery: pytest for Python test files
	if (hasFilesMatching(repoPath, /^(test_.*|.*_test)\.py$/)) {
		execCwd("pytest", repoPath);
		return;
	}

	// 5. Fallback: no tests found — silent success per spec
}

function hasFilesMatching(repoPath: string, pattern: RegExp): boolean {
	try {
		const entries = fs.readdirSync(repoPath, { withFileTypes: true });
		return entries.some((e) => e.isFile() && pattern.test(e.name));
	} catch {
		return false;
	}
}

function execCwd(cmd: string, cwd: string): void {
	execSync(cmd, {
		cwd,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	});
}

// ─── Main Validation Pipeline ────────────────────────────────────────────────

/**
 * Run the full validation pipeline for a single repository:
 *   1. Optional test cascade
 *   2. git add -A
 *   3. Extract diff + compute diffHash
 *   4. Secret scan (fail-closed)
 *
 * Throws on test failure, empty diff, secret detection, or scanner error.
 */
export async function processRepoValidationAndDiff(
	repo: RepositoryInfo,
	settings: Settings,
	scanner: SecretScanner = defaultScanner,
): Promise<{ diff: string; diffHash: string }> {
	// 1. Test cascade (unless explicitly skipped)
	if (!settings.skipTests) {
		await runTestCascade(repo.path);
	}

	// 2. Stage all files
	execCwd("git add -A", repo.path);

	// 3. Extract diff
	const diff = execSync("git diff --cached", {
		cwd: repo.path,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	});

	if (!diff.trim()) {
		throw new Error("No changes found after staging.");
	}

	const diffHash = crypto.createHash("sha256").update(diff).digest("hex");

	// 4. Security scan — fail closed (DC-SECRET-SCANNER §3)
	const scanResult = await scanner(diff);
	if (scanResult.hasSecrets) {
		throw new Error(
			`Security Exception: Secret detected in diff. ${scanResult.details ?? ""}`,
		);
	}

	return { diff, diffHash };
}
