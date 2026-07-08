export interface ScanResult {
	clean: boolean;
	findings: Finding[];
	warnings: Finding[];
}

export interface Finding {
	name: string;
	line: string;
	lineNumber: number;
	filePath?: string;
	reason?: string;
}

interface SecretPattern {
	name: string;
	pattern: RegExp;
	confirm?: (content: string) => boolean;
}

const PASSWORD_PLACEHOLDERS = [
	"changeme",
	"password",
	"placeholder",
	"example",
	"xxx",
	"xxxxxxxx",
	"todo",
	"fixme",
];

function extractAssignedValue(content: string): string {
	const match = content.match(/[:=]\s*['"]?(.*?)['"]?\s*$/);
	if (!match) return "";
	return match[1]?.replace(/^['"]|['"]$/g, "") ?? "";
}

const SECRET_PATTERNS: SecretPattern[] = [
	{ name: "AWS Access Key", pattern: /AKIA[0-9A-Z]{16}/ },
	{
		name: "AWS Secret Key",
		pattern: /(?:aws_secret_access_key|aws_secret_key)\s*=\s*\S{20,}/i,
	},
	{
		name: "Private Key",
		pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,
	},
	{ name: "GitHub Token", pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
	{
		name: "Slack Token",
		pattern: /xox[baprs]-[0-9]{10,}-[a-zA-Z0-9-]+/,
	},
	{
		name: "Connection String",
		pattern:
			/(?:mongodb|postgres|postgresql|mysql|redis):\/\/[^\s:]+:[^\s@]+@[^\s]+/,
	},
	{
		name: "Generic API Key",
		pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?\S{20,}/i,
	},
	{
		name: "Generic Token",
		pattern: /(?:auth_token|access_token|refresh_token)\s*[:=]\s*['"]?\S{20,}/i,
	},
	{
		name: "Env Secret",
		pattern:
			/(?:SECRET_KEY|PRIVATE_KEY|STRIPE_API_KEY|STRIPE_SECRET|OPENAI_API_KEY|ANTHROPIC_API_KEY|SENDGRID_API_KEY)\s*=\s*\S{16,}/,
	},
	{
		name: "Password / Secret",
		pattern:
			/(?:password|passwd|pwd|DB_PASSWORD|MYSQL_PASSWORD|POSTGRES_PASSWORD)\s*=\s*/i,
		confirm: (content: string) => {
			const value = extractAssignedValue(content);
			if (value.length < 8) return false;
			return !PASSWORD_PLACEHOLDERS.includes(value.toLowerCase());
		},
	},
];

const FALSE_POSITIVE_PATTERNS = [
	/process\.env[.[]\w+/,
	/os\.environ\[/,
	/\$\{?\w+\}?/,
	/getenv\(/,
	/requireEnv\(/,
	/getApiKey\(/,
];

const ALLOW_SECRET_ANNOTATION = "git-commits-push: allow-secret";
const MOCK_KEYWORD_PATTERN = /\b(?:mock|dummy|test|example|fake)\b/i;
const NON_PRODUCTION_PATH_SEGMENTS = new Set([
	"test",
	"tests",
	"__tests__",
	"specs",
	"fixtures",
]);
const ENV_EXAMPLE_FILENAMES = new Set([
	".env.example",
	".env.template",
	".env.sample",
]);

function parseDiffGitPath(line: string): string | undefined {
	const match = line.match(/^diff --git a\/.+ b\/(.+)$/);
	return match?.[1];
}

function parseAddedFilePath(line: string): string | undefined {
	if (!line.startsWith("+++ ")) return undefined;
	const rawPath = line.slice(4).trim();
	if (rawPath === "/dev/null") return undefined;
	return rawPath.startsWith("b/") ? rawPath.slice(2) : rawPath;
}

function isNonProductionPath(filePath: string | undefined): boolean {
	if (!filePath) return false;
	const segments = filePath.toLowerCase().split(/[\\/]/);
	return segments.some((segment) => NON_PRODUCTION_PATH_SEGMENTS.has(segment));
}

function isEnvExamplePath(filePath: string | undefined): boolean {
	if (!filePath) return false;
	const filename = filePath.toLowerCase().split(/[\\/]/).pop();
	return filename ? ENV_EXAMPLE_FILENAMES.has(filename) : false;
}

function hasInlineAllowSecretAnnotation(content: string): boolean {
	return content.includes(ALLOW_SECRET_ANNOTATION);
}

function hasMockKeyword(content: string): boolean {
	return MOCK_KEYWORD_PATTERN.test(content);
}

function buildFinding(
	name: string,
	content: string,
	lineNumber: number,
	filePath: string | undefined,
	reason?: string,
): Finding {
	return {
		name,
		line: content.trim(),
		lineNumber,
		...(filePath ? { filePath } : {}),
		...(reason ? { reason } : {}),
	};
}

export function scanDiff(diff: string): ScanResult {
	if (!diff.trim()) {
		return { clean: true, findings: [], warnings: [] };
	}

	const findings: Finding[] = [];
	const warnings: Finding[] = [];
	const lines = diff.split("\n");
	let currentFilePath: string | undefined;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) continue;

		if (line.startsWith("diff --git ")) {
			currentFilePath = parseDiffGitPath(line);
			continue;
		}

		if (line.startsWith("+++ ")) {
			currentFilePath = parseAddedFilePath(line);
			continue;
		}

		if (!line.startsWith("+")) continue;

		const content = line.slice(1);
		if (isEnvExamplePath(currentFilePath)) continue;
		if (hasInlineAllowSecretAnnotation(content)) continue;
		if (hasMockKeyword(content)) continue;
		if (FALSE_POSITIVE_PATTERNS.some((pattern) => pattern.test(content))) {
			continue;
		}

		for (const { name, pattern, confirm } of SECRET_PATTERNS) {
			if (pattern.test(content)) {
				if (confirm && !confirm(content)) continue;
				const finding = buildFinding(
					name,
					content,
					i + 1,
					currentFilePath,
					isNonProductionPath(currentFilePath)
						? "non-production path"
						: undefined,
				);
				if (finding.reason === "non-production path") {
					warnings.push(finding);
				} else {
					findings.push(finding);
				}
				break;
			}
		}
	}

	return { clean: findings.length === 0, findings, warnings };
}
