/**
 * src/modules/validation.ts — Phase 2: Validation & Diff Extraction
 *
 * Implements NIB-M-VALIDATION §3.
 *
 * secret-scanner is inlined in ./secret-scanner.ts.
 */

import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RepositoryInfo, Settings } from "../types.ts";
import { scanDiff } from "./secret-scanner";

// ─── Secret Scanner Adapter ──────────────────────────────────────────────────

export interface ScanResult {
	hasSecrets: boolean;
	details?: string;
	matchCount: number;
}

export type SecretScanner = (diffContent: string) => Promise<ScanResult>;

/**
 * Default scanner used in production.
 * Uses the inlined secret-scanner module.
 */
const defaultScanner: SecretScanner = async (
	diff: string,
): Promise<ScanResult> => {
	try {
		const result = scanDiff(diff);
		const details = result.findings
			?.map((f) => `${f.name} at line ${f.lineNumber}`)
			.join(", ");
		return {
			hasSecrets: !result.clean,
			matchCount: result.findings?.length ?? 0,
			...(details ? { details } : {}),
		};
	} catch (err) {
		throw new Error(
			`Failed to execute secret-scanner: ${err instanceof Error ? err.message : String(err)}`,
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

import { createEventSink } from "/Users/famillesendrison/Developper/Projects/telemetry-tools/event-sink/src/index.ts";

let secretSink: ReturnType<typeof createEventSink> | null = null;
let lastStatsDir: string | undefined = undefined;

function getSecretSink(): ReturnType<typeof createEventSink> {
	const currentStatsDir = process.env.SECRET_SCANNER_STATS_DIR;
	if (!secretSink || currentStatsDir !== lastStatsDir) {
		lastStatsDir = currentStatsDir;
		let statsDir = currentStatsDir;
		const agent = process.env.ANTIGRAVITY_AGENT === "1" ? "antigravity" : "pi";
		if (!statsDir) {
			if (process.env.PI_SKILL_STATS_DIR) {
				statsDir = path.join(process.env.PI_SKILL_STATS_DIR, "..", "secret-scanner");
			} else {
				statsDir = path.join(os.homedir(), "neelopedia", "stats", agent, "secret-scanner");
			}
		}
		secretSink = createEventSink({
			statsDir,
			agent,
			namespace: "secret-scanner",
		});
	}
	return secretSink;
}

function logSecretBlock(opts: {
	repoId: string;
	repoPath: string;
	matchCount: number;
	details: string;
}): void {
	if (process.env.PI_SKILL_STATS_MODE === "test") return;
	if (
		process.env.NODE_ENV === "test" &&
		!process.env.SECRET_SCANNER_STATS_DIR &&
		!process.env.PI_SKILL_STATS_DIR
	) {
		return;
	}
	const findings = opts.details
		.split(", ")
		.filter(Boolean)
		.map((d) => {
			const match = d.match(/^(.*) at line (\d+)$/);
			if (match) {
				return { name: match[1] || "", line: "", lineNumber: parseInt(match[2] || "0", 10) };
			}
			return { name: d, line: "", lineNumber: 0 };
		});

	getSecretSink().append(
		"block",
		{
			findingsCount: opts.matchCount,
			findings,
			_source: "git-commits-push-skill",
		},
		{
			sessionId: `skill-${opts.repoId}`,
			workspace: opts.repoPath,
		},
	);
}

function logSecretPass(opts: {
	repoId: string;
	repoPath: string;
}): void {
	if (process.env.PI_SKILL_STATS_MODE === "test") return;
	if (
		process.env.NODE_ENV === "test" &&
		!process.env.SECRET_SCANNER_STATS_DIR &&
		!process.env.PI_SKILL_STATS_DIR
	) {
		return;
	}
	getSecretSink().append(
		"passed",
		{
			findingsCount: 0,
			findings: [],
			_source: "git-commits-push-skill",
		},
		{
			sessionId: `skill-${opts.repoId}`,
			workspace: opts.repoPath,
		},
	);
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
		// Log to Pi stats events.jsonl
		logSecretBlock({
			repoId: repo.id,
			repoPath: repo.path,
			matchCount: scanResult.matchCount,
			details: scanResult.details ?? "",
		});

		throw new Error(
			`Security Exception: Secret detected in diff. ${scanResult.details ?? ""}`,
		);
	}

	logSecretPass({
		repoId: repo.id,
		repoPath: repo.path,
	});

	return { diff, diffHash };
}
