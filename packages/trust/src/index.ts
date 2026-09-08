import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const TRUSTED_MARKER_ENV = "GIT_COMMITS_PUSH_ENFORCER_SOURCE";
export const TRUSTED_TOKEN_ENV = "GIT_COMMITS_PUSH_ENFORCER_TOKEN";
export const TRUSTED_MARKER_VALUE = "skill";
export const TRUST_TOKEN_STORE_DIRECTORY = join(
	tmpdir(),
	"git-commits-push-trust-tokens",
);

const TOKEN_TTL_MS = 30_000;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const TRUSTED_ISSUER = "git-commits-push-internal-git-helper";
const TRUST_TOKEN_RECORD_KEYS = [
	"createdAt",
	"expiresAt",
	"issuer",
	"issuerCwd",
	"issuerPid",
	"issuerPpid",
	"issuerStackHash",
	"version",
] as const;

const trustModulePath = fileURLToPath(import.meta.url);
const trustPackageDirectory = dirname(dirname(trustModulePath));
const workspacePackagesDirectory = dirname(trustPackageDirectory);
const workspaceRuntimeRoot =
	basename(trustPackageDirectory) === "trust" &&
	basename(workspacePackagesDirectory) === "packages"
		? dirname(workspacePackagesDirectory)
		: null;
const STABLE_SEMVER_PATTERN_SOURCE = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)`;
const RELEASE_DIRECTORY_PATTERN = new RegExp(
	`^${STABLE_SEMVER_PATTERN_SOURCE}-[a-f0-9]{64}$`,
);

function resolveSourceRuntimeRoot(homeDirectory: string): string {
	return (
		workspaceRuntimeRoot ??
		join(homeDirectory, "Developper", "Projects", "git-commits-push")
	);
}

function canonicalizeExistingPath(candidate: string): string {
	try {
		return realpathSync(candidate).normalize("NFC");
	} catch {
		return normalize(candidate).normalize("NFC");
	}
}

function installedReleaseRootForPath(candidate: string): string | null {
	let current = canonicalizeExistingPath(candidate);
	while (dirname(current) !== current) {
		if (
			RELEASE_DIRECTORY_PATTERN.test(basename(current)) &&
			basename(dirname(current)) === "releases" &&
			basename(dirname(dirname(current))) === "git-commits-push"
		) {
			return current;
		}
		current = dirname(current);
	}
	return null;
}

function isInstalledReleaseWorkingDirectory(candidate: string): boolean {
	const normalizedCandidate = canonicalizeExistingPath(candidate);
	if (basename(normalizedCandidate) !== "dist") return false;
	const releaseRoot = dirname(normalizedCandidate);
	return installedReleaseRootForPath(releaseRoot) === releaseRoot;
}

/** Recognize source and structurally valid immutable release working directories. */
export function isAuthorizedTrustTokenIssuerWorkingDirectory(
	candidate: string,
	homeDirectory: string = homedir(),
): boolean {
	if (!isAbsolute(candidate)) return false;
	const normalizedCandidate = canonicalizeExistingPath(candidate);
	const sourceRuntimeRoot = canonicalizeExistingPath(
		resolveSourceRuntimeRoot(homeDirectory),
	);
	return (
		normalizedCandidate === sourceRuntimeRoot ||
		normalizedCandidate === join(sourceRuntimeRoot, "dist") ||
		isInstalledReleaseWorkingDirectory(normalizedCandidate)
	);
}

function trustModuleCanMintFrom(workingDirectory: string): boolean {
	const normalizedWorkingDirectory = canonicalizeExistingPath(workingDirectory);
	if (workspaceRuntimeRoot !== null) {
		const sourceRoot = canonicalizeExistingPath(workspaceRuntimeRoot);
		return (
			normalizedWorkingDirectory === sourceRoot ||
			normalizedWorkingDirectory === join(sourceRoot, "dist")
		);
	}
	const moduleReleaseRoot = installedReleaseRootForPath(trustPackageDirectory);
	return (
		moduleReleaseRoot !== null &&
		normalizedWorkingDirectory === join(moduleReleaseRoot, "dist")
	);
}

function authorizedIssuerPathsForWorkingDirectory(
	workingDirectory: string,
): readonly string[] {
	const sourceRuntimeRoot = resolveSourceRuntimeRoot(homedir());
	if (workingDirectory === sourceRuntimeRoot) {
		return [
			join(sourceRuntimeRoot, "src", "modules", "git", "git-exec.ts"),
			join(sourceRuntimeRoot, "src", "utils", "git-utils.ts"),
			join(sourceRuntimeRoot, "dist", "src", "modules", "git", "git-exec.js"),
			join(sourceRuntimeRoot, "dist", "src", "utils", "git-utils.js"),
		];
	}
	return [
		join(workingDirectory, "src", "modules", "git", "git-exec.js"),
		join(workingDirectory, "src", "utils", "git-utils.js"),
	];
}

interface TrustTokenRecord {
	readonly version: 1;
	readonly issuer: typeof TRUSTED_ISSUER;
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly issuerPid: number;
	readonly issuerPpid: number;
	readonly issuerCwd: string;
	readonly issuerStackHash: string;
}

function hasStackPathBoundary(stack: string, issuerPath: string): boolean {
	let searchIndex = 0;
	while (searchIndex < stack.length) {
		const issuerPathIndex = stack.indexOf(issuerPath, searchIndex);
		if (issuerPathIndex === -1) return false;
		const nextCharacter = stack[issuerPathIndex + issuerPath.length];
		if (
			nextCharacter === undefined ||
			nextCharacter === ":" ||
			nextCharacter === ")" ||
			nextCharacter === "\n"
		) {
			return true;
		}
		searchIndex = issuerPathIndex + issuerPath.length;
	}
	return false;
}

function normalizeStackPaths(stack: string): string | null {
	try {
		return decodeURI(stack).replaceAll("\\", "/").normalize("NFC");
	} catch {
		return null;
	}
}

export function isAuthorizedTrustTokenIssuerStack(
	stack: string | undefined,
	workingDirectory: string = process.cwd(),
): boolean {
	if (
		!stack ||
		!isAuthorizedTrustTokenIssuerWorkingDirectory(workingDirectory)
	) {
		return false;
	}
	const normalizedStack = normalizeStackPaths(stack);
	if (normalizedStack === null) return false;
	return authorizedIssuerPathsForWorkingDirectory(workingDirectory).some(
		(issuerPath) =>
			hasStackPathBoundary(
				normalizedStack,
				issuerPath.replaceAll("\\", "/").normalize("NFC"),
			),
	);
}

function createTrustTokenRecord(stack: string): TrustTokenRecord {
	if (!isAuthorizedTrustTokenIssuerStack(stack)) {
		throw new Error(
			"Trust tokens can only be created by git-commits-push internal git helpers.",
		);
	}
	if (!trustModuleCanMintFrom(process.cwd())) {
		throw new Error(
			"Trust tokens require the executing git-commits-push runtime directory.",
		);
	}
	const createdAt = Date.now();
	return {
		version: 1,
		issuer: TRUSTED_ISSUER,
		createdAt,
		expiresAt: createdAt + TOKEN_TTL_MS,
		issuerPid: process.pid,
		issuerPpid: process.ppid,
		issuerCwd: process.cwd(),
		issuerStackHash: createHash("sha256").update(stack).digest("hex"),
	};
}

function hasExpectedOwner(uid: number): boolean {
	return process.getuid === undefined || uid === process.getuid();
}

function ensureStoreDirectory(): void {
	if (!existsSync(TRUST_TOKEN_STORE_DIRECTORY)) {
		mkdirSync(TRUST_TOKEN_STORE_DIRECTORY, { recursive: true, mode: 0o700 });
	}
	const stats = lstatSync(TRUST_TOKEN_STORE_DIRECTORY);
	if (
		!stats.isDirectory() ||
		stats.isSymbolicLink() ||
		(stats.mode & 0o777) !== 0o700 ||
		!hasExpectedOwner(stats.uid)
	) {
		throw new Error(
			`Trust token store is not a private physical directory: ${TRUST_TOKEN_STORE_DIRECTORY}`,
		);
	}
}

function cleanupToken(tokenPath: string): void {
	try {
		unlinkSync(tokenPath);
	} catch {
		// Cleanup is best-effort because validation remains fail-closed.
	}
}

function writeUniqueToken(record: TrustTokenRecord): string {
	for (let attempt = 0; attempt < 3; attempt++) {
		const token = randomBytes(32).toString("hex");
		try {
			writeFileSync(
				join(TRUST_TOKEN_STORE_DIRECTORY, token),
				JSON.stringify(record),
				{ encoding: "utf8", flag: "wx", mode: 0o600 },
			);
			return token;
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				(error as NodeJS.ErrnoException).code !== "EEXIST"
			) {
				throw error;
			}
		}
	}
	throw new Error("Unable to allocate a unique trust token.");
}

export function createTrustToken(): string {
	const stack = new Error().stack;
	if (!stack)
		throw new Error("Unable to establish the trust token issuer stack.");
	ensureStoreDirectory();
	return writeUniqueToken(createTrustTokenRecord(stack));
}

function readParentProcessId(pid: number): number | null {
	if (pid === process.pid) return process.ppid;
	try {
		const output = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const parentPid = Number.parseInt(output, 10);
		return Number.isSafeInteger(parentPid) && parentPid >= 0 ? parentPid : null;
	} catch {
		return null;
	}
}

function isIssuerProcessAncestor(
	issuerPid: number,
	issuerPpid: number,
): boolean {
	let candidatePid = process.pid;
	for (let depth = 0; depth < 64 && candidatePid > 0; depth++) {
		if (candidatePid === issuerPid) {
			return readParentProcessId(candidatePid) === issuerPpid;
		}
		const parentPid = readParentProcessId(candidatePid);
		if (parentPid === null || parentPid === candidatePid) return false;
		candidatePid = parentPid;
	}
	return false;
}

function isValidRecord(record: unknown): record is TrustTokenRecord {
	if (typeof record !== "object" || record === null || Array.isArray(record)) {
		return false;
	}
	const candidate = record as Partial<TrustTokenRecord>;
	const keys = Object.keys(record).sort();
	if (
		keys.length !== TRUST_TOKEN_RECORD_KEYS.length ||
		!TRUST_TOKEN_RECORD_KEYS.every((key, index) => keys[index] === key) ||
		candidate.version !== 1 ||
		candidate.issuer !== TRUSTED_ISSUER ||
		typeof candidate.createdAt !== "number" ||
		typeof candidate.expiresAt !== "number" ||
		typeof candidate.issuerPid !== "number" ||
		typeof candidate.issuerPpid !== "number" ||
		typeof candidate.issuerCwd !== "string" ||
		!isAuthorizedTrustTokenIssuerWorkingDirectory(candidate.issuerCwd) ||
		typeof candidate.issuerStackHash !== "string"
	) {
		return false;
	}

	const now = Date.now();
	return (
		Number.isSafeInteger(candidate.createdAt) &&
		Number.isSafeInteger(candidate.expiresAt) &&
		candidate.expiresAt === candidate.createdAt + TOKEN_TTL_MS &&
		candidate.createdAt <= now + 1_000 &&
		now <= candidate.expiresAt &&
		Number.isSafeInteger(candidate.issuerPid) &&
		candidate.issuerPid > 0 &&
		Number.isSafeInteger(candidate.issuerPpid) &&
		candidate.issuerPpid >= 0 &&
		TOKEN_PATTERN.test(candidate.issuerStackHash) &&
		isIssuerProcessAncestor(candidate.issuerPid, candidate.issuerPpid)
	);
}

function claimToken(tokenPath: string): string | null {
	const claimedPath = `${tokenPath}.claimed-${String(process.pid)}-${randomBytes(8).toString("hex")}`;
	try {
		renameSync(tokenPath, claimedPath);
		return claimedPath;
	} catch {
		return null;
	}
}

function isSecureClaimedToken(claimedPath: string): boolean {
	try {
		const stats = lstatSync(claimedPath);
		return (
			stats.isFile() &&
			!stats.isSymbolicLink() &&
			(stats.mode & 0o777) === 0o600 &&
			stats.size > 0 &&
			stats.size <= 4_096 &&
			hasExpectedOwner(stats.uid)
		);
	} catch {
		return false;
	}
}

export function validateTrustToken(token: string | undefined): boolean {
	if (!token || !TOKEN_PATTERN.test(token)) return false;
	try {
		ensureStoreDirectory();
	} catch {
		return false;
	}
	const claimedPath = claimToken(join(TRUST_TOKEN_STORE_DIRECTORY, token));
	if (!claimedPath) return false;
	try {
		if (!isSecureClaimedToken(claimedPath)) return false;
		const record: unknown = JSON.parse(readFileSync(claimedPath, "utf8"));
		return isValidRecord(record);
	} catch {
		return false;
	} finally {
		cleanupToken(claimedPath);
	}
}
