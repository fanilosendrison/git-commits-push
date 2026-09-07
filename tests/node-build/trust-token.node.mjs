import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "../..");
const compiledRoot = path.join(skillDirectory, "dist");
const compiledTrustStorePath = path.join(
	skillDirectory,
	"packages",
	"trust",
	"dist",
	"index.js",
);
const compiledGitExecPath = path.join(
	compiledRoot,
	"src",
	"modules",
	"git",
	"git-exec.js",
);
const validatorPath = path.join(
	skillDirectory,
	"packages",
	"trust",
	"test",
	"validate-token-child.mjs",
);
const trustStore = await import(pathToFileURL(compiledTrustStorePath).href);

function runValidator(token) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [validatorPath, token], {
			cwd: skillDirectory,
			stdio: ["ignore", "pipe", "inherit"],
		});
		let output = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
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

async function withTemporaryDirectory(callback) {
	const directory = await mkdtemp(
		path.join(tmpdir(), "compiled-trust-token-é-"),
	);
	try {
		await callback(directory);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

test("authorizes only source and compiled internal Git helper stacks", () => {
	for (const stackPath of [
		path.join(skillDirectory, "src", "modules", "git", "git-exec.ts"),
		path.join(skillDirectory, "src", "utils", "git-utils.ts"),
		path.join(skillDirectory, "dist", "src", "modules", "git", "git-exec.js"),
		path.join(skillDirectory, "dist", "src", "utils", "git-utils.js"),
	]) {
		assert.equal(
			trustStore.isAuthorizedTrustTokenIssuerStack(
				`at helper (${stackPath}:1:1)`,
			),
			true,
		);
	}
	assert.equal(
		trustStore.isAuthorizedTrustTokenIssuerStack(
			"at forged (/tmp/git-commits-push/src/utils/git-utils.ts:1:1)",
		),
		false,
	);
});

test("compiled Git helper mints a permission-restricted one-shot token", async () => {
	await withTemporaryDirectory(async (directory) => {
		const binDirectory = path.join(directory, "bin with spaces");
		const fakeGitPath = path.join(binDirectory, "git");
		await mkdir(binDirectory, { recursive: true });
		await writeFile(
			fakeGitPath,
			"#!/bin/sh\nprintf '%s\\n' \"$GIT_COMMITS_PUSH_ENFORCER_TOKEN\"\n",
			{ mode: 0o755 },
		);
		await chmod(fakeGitPath, 0o755);

		const previousPath = process.env.PATH;
		process.env.PATH = `${binDirectory}${path.delimiter}${previousPath ?? ""}`;
		try {
			const { gitExec } = await import(pathToFileURL(compiledGitExecPath).href);
			const token = gitExec("status", directory);
			assert.match(token, /^[a-f0-9]{64}$/);
			const tokenPath = path.join(
				tmpdir(),
				"git-commits-push-trust-tokens",
				token,
			);
			assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
			const results = await Promise.all(
				Array.from({ length: 12 }, () => runValidator(token)),
			);
			assert.equal(results.filter((result) => result === "valid").length, 1);
			assert.equal(results.filter((result) => result === "invalid").length, 11);
			await assert.rejects(readFile(tokenPath), { code: "ENOENT" });

			for (const forgedToken of [token, "0".repeat(64)]) {
				assert.equal(trustStore.validateTrustToken(forgedToken), false);
			}
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});
});

test("compiled trust store rejects direct token minting", () => {
	assert.throws(
		() => trustStore.createTrustToken(),
		/Trust tokens can only be created by git-commits-push internal git helpers/,
	);
});
