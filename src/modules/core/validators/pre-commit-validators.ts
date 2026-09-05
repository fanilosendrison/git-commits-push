import { execFileSync, execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RepositoryInfo, Settings } from "../../../types.ts";
import { createSkillStatsLog } from "../../telemetry/stats-logger.ts";
import { scanDiff } from "../secret-scanner.ts";

export interface ScanResult {
	hasSecrets: boolean;
	details?: string;
	matchCount: number;
	warningCount?: number;
	warningDetails?: string;
}

export type SecretScanner = (diffContent: string) => Promise<ScanResult>;

interface PackageTestConfiguration {
	readonly packageManager?: string;
	readonly scripts?: Readonly<Record<string, string>>;
}

const defaultScanner: SecretScanner = async (
	diff: string,
): Promise<ScanResult> => {
	try {
		const result = scanDiff(diff);
		const details = result.findings
			?.map((f) => `${f.name} at line ${f.lineNumber}`)
			.join(", ");
		const warningDetails = result.warnings
			?.map((f) => `${f.name} at line ${f.lineNumber}`)
			.join(", ");
		return {
			hasSecrets: !result.clean,
			matchCount: result.findings?.length ?? 0,
			warningCount: result.warnings?.length ?? 0,
			...(details ? { details } : {}),
			...(warningDetails ? { warningDetails } : {}),
		};
	} catch (err) {
		throw new Error(
			`Failed to execute secret-scanner: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
};

export async function runTestCascade(repoPath: string): Promise<void> {
	const stackEvalPath = path.join(repoPath, "STACK_EVAL.yaml");
	if (fs.existsSync(stackEvalPath)) {
		const raw = fs.readFileSync(stackEvalPath, "utf-8");
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
				case "node --test":
					execNodeTests(repoPath);
					return;
				case "none":
					return;
			}
		}
	}

	const pkgPath = path.join(repoPath, "package.json");
	if (fs.existsSync(pkgPath)) {
		let pkg: PackageTestConfiguration | undefined;
		try {
			pkg = JSON.parse(
				fs.readFileSync(pkgPath, "utf-8"),
			) as PackageTestConfiguration;
		} catch {
			// Preserve file-based fallback when package metadata is unreadable.
		}

		if (pkg?.scripts?.test) {
			const declaredPackageManager = pkg.packageManager?.match(
				/^(bun|npm|pnpm|yarn)@/,
			)?.[1];
			if (declaredPackageManager) {
				execCwd(`${declaredPackageManager} run test`, repoPath);
				return;
			}
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
	}

	const nodeTestFiles = listFilesMatching(repoPath, /\.(test|spec)\.(ts|js)$/);
	if (nodeTestFiles.length > 0) {
		execNodeTests(repoPath, nodeTestFiles);
		return;
	}

	if (hasFilesMatching(repoPath, /^(test_.*|.*_test)\.py$/)) {
		execCwd("pytest", repoPath);
		return;
	}
}

function listFilesMatching(repoPath: string, pattern: RegExp): string[] {
	try {
		return fs
			.readdirSync(repoPath, { withFileTypes: true })
			.filter((entry) => entry.isFile() && pattern.test(entry.name))
			.map((entry) => path.join(repoPath, entry.name));
	} catch {
		return [];
	}
}

function hasFilesMatching(repoPath: string, pattern: RegExp): boolean {
	return listFilesMatching(repoPath, pattern).length > 0;
}

const skillLog = createSkillStatsLog();

function buildTestRunnerEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	// A nested Node test runner otherwise sees the parent test worker marker and
	// deliberately skips its files instead of executing the repository tests.
	delete env.NODE_TEST_CONTEXT;
	return env;
}

function execNodeTests(cwd: string, testFiles: readonly string[] = []): void {
	execFileSync("node", ["--test", ...testFiles], {
		cwd,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		maxBuffer: 50 * 1024 * 1024,
		env: buildTestRunnerEnvironment(),
	});
}

function execCwd(cmd: string, cwd: string): void {
	execSync(cmd, {
		cwd,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		maxBuffer: 50 * 1024 * 1024,
		env: buildTestRunnerEnvironment(),
	});
}

export async function validateDiffForSecrets(
	repo: RepositoryInfo,
	diff: string,
	scanner: SecretScanner = defaultScanner,
): Promise<void> {
	const scanResult = await scanner(diff);
	if (scanResult.hasSecrets) {
		skillLog.logSecretBlock({
			repoId: repo.id,
			repoPath: repo.path,
			matchCount: scanResult.matchCount,
			details: scanResult.details ?? "",
		});
		throw new Error(
			`Security Exception: Secret detected in diff. ${scanResult.details ?? ""}`,
		);
	}

	if (scanResult.warningCount && scanResult.warningCount > 0) {
		skillLog.logSecretWarning({
			repoId: repo.id,
			repoPath: repo.path,
			matchCount: scanResult.warningCount,
			details: scanResult.warningDetails ?? "",
		});
		return;
	}

	skillLog.logSecretPass({ repoId: repo.id, repoPath: repo.path });
}

export async function processRepoValidationAndDiff(
	repo: RepositoryInfo,
	settings: Settings,
	scanner: SecretScanner = defaultScanner,
): Promise<{ diff: string; diffHash: string }> {
	if (!settings.skipTests) {
		await runTestCascade(repo.path);
	}

	// Stage internal submodule changes first so that `git add -A` in
	// the parent picks up the updated gitlink SHAs.
	execCwd("git submodule foreach --quiet --recursive 'git add -A'", repo.path);
	execCwd("git add -A", repo.path);

	const diff = execSync("git diff --cached", {
		cwd: repo.path,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		maxBuffer: 50 * 1024 * 1024,
	});

	if (!diff.trim()) {
		throw new Error("No changes found after staging.");
	}

	const diffHash = crypto.createHash("sha256").update(diff).digest("hex");

	await validateDiffForSecrets(repo, diff, scanner);

	return { diff, diffHash };
}
