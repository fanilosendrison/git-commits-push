export interface ScanResult {
	clean: boolean;
	findings: Finding[];
}

export interface Finding {
	name: string;
	line: string;
	lineNumber: number;
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

export function scanDiff(diff: string): ScanResult {
	if (!diff.trim()) {
		return { clean: true, findings: [] };
	}

	const findings: Finding[] = [];
	const lines = diff.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line.startsWith("+")) continue;
		if (line.startsWith("+++")) continue;

		const content = line.slice(1);
		if (FALSE_POSITIVE_PATTERNS.some((pattern) => pattern.test(content))) {
			continue;
		}

		for (const { name, pattern, confirm } of SECRET_PATTERNS) {
			if (pattern.test(content)) {
				if (confirm && !confirm(content)) continue;
				findings.push({ name, line: content.trim(), lineNumber: i + 1 });
				break;
			}
		}
	}

	return { clean: findings.length === 0, findings };
}
