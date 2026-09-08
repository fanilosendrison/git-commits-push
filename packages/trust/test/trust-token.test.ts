import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import {
	createTrustToken,
	isAuthorizedTrustTokenIssuerStack,
	isAuthorizedTrustTokenIssuerWorkingDirectory,
	TRUST_TOKEN_STORE_DIRECTORY,
	validateTrustToken,
} from "../dist/index.js";

const runtimeRoot = path.resolve(import.meta.dirname, "../../..");

function runValidator(token: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[path.join(import.meta.dirname, "validate-token-child.mjs"), token],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		let output = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
		});
		child.once("error", reject);
		child.once("close", (exitCode) => {
			if (exitCode !== 0) {
				reject(new Error(`validator child exited with ${String(exitCode)}`));
				return;
			}
			resolve(output);
		});
	});
}

describe("trust token protocol", () => {
	test("rejects malformed tokens and direct minting", () => {
		assert.equal(validateTrustToken(undefined), false);
		assert.equal(validateTrustToken("not-a-token"), false);
		assert.throws(
			() => createTrustToken(),
			/only be created by git-commits-push internal git helpers/,
		);
	});

	test("recognizes only helper paths in this workspace", () => {
		for (const stackPath of [
			path.join(runtimeRoot, "src", "modules", "git", "git-exec.ts"),
			path.join(runtimeRoot, "src", "utils", "git-utils.ts"),
			path.join(runtimeRoot, "dist", "src", "modules", "git", "git-exec.js"),
			path.join(runtimeRoot, "dist", "src", "utils", "git-utils.js"),
		]) {
			assert.equal(
				isAuthorizedTrustTokenIssuerStack(
					`at helper (${stackPath}:1:1)`,
					runtimeRoot,
				),
				true,
			);
		}
		assert.equal(
			isAuthorizedTrustTokenIssuerStack(
				`at helper (${path.join(runtimeRoot, "src", "utils", "git-utils.ts").replace("git-commits-push", "git-commits%2Dpush")}:1:1)`,
				runtimeRoot,
			),
			true,
		);
		assert.equal(
			isAuthorizedTrustTokenIssuerStack(
				"at forged (/tmp/git-commits-push/src/utils/git-utils.ts:1:1)",
				runtimeRoot,
			),
			false,
		);
	});

	test("recognizes content-addressed releases independently of runtime XDG variables", () => {
		const homeDirectory = path.join(path.sep, "tmp", "isolated-home");
		const dataHome = path.join(path.sep, "custom", "application-data");
		const releaseRoot = path.join(
			dataHome,
			"git-commits-push",
			"releases",
			`0.4.0-${"a".repeat(64)}`,
		);
		assert.equal(
			isAuthorizedTrustTokenIssuerWorkingDirectory(
				path.join(releaseRoot, "dist"),
				homeDirectory,
			),
			true,
		);
		for (const rejected of [
			releaseRoot,
			path.join(dataHome, "git-commits-push", "current", "dist"),
			path.join(
				dataHome,
				"git-commits-push",
				"releases",
				"0.4.0-not-a-digest",
				"dist",
			),
			path.join(
				dataHome,
				"git-commits-push",
				"releases",
				`01.2.3-${"b".repeat(64)}`,
				"dist",
			),
		]) {
			assert.equal(
				isAuthorizedTrustTokenIssuerWorkingDirectory(rejected, homeDirectory),
				false,
			);
		}
	});

	test("rejects a record whose claimed issuer is not a live ancestor", async () => {
		const token = "a".repeat(48) + Date.now().toString(16).padStart(16, "0");
		const createdAt = Date.now();
		await mkdir(TRUST_TOKEN_STORE_DIRECTORY, { recursive: true, mode: 0o700 });
		await writeFile(
			path.join(TRUST_TOKEN_STORE_DIRECTORY, token),
			JSON.stringify({
				version: 1,
				issuer: "git-commits-push-internal-git-helper",
				createdAt,
				expiresAt: createdAt + 30_000,
				issuerPid: 2_147_483_647,
				issuerPpid: 0,
				issuerCwd: runtimeRoot,
				issuerStackHash: "b".repeat(64),
			}),
			{ encoding: "utf8", flag: "wx", mode: 0o600 },
		);
		const results = await Promise.all(
			Array.from({ length: 12 }, () => runValidator(token)),
		);
		assert.deepEqual(new Set(results), new Set(["invalid"]));
	});
});
