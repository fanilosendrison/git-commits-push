import assert from "node:assert/strict";
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
	compiledRoot,
	"agent-enforcers",
	"git-commits-push-enforcer",
	"src",
	"core",
	"trust-store.js",
);
const compiledGitExecPath = path.join(
	compiledRoot,
	"skills",
	"git-commits-push",
	"src",
	"modules",
	"git",
	"git-exec.js",
);
const trustStore = await import(pathToFileURL(compiledTrustStorePath).href);

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
	for (const extension of ["ts", "js"]) {
		assert.equal(
			trustStore.isAuthorizedTrustTokenIssuerStack(
				`at gitExec (/workspace/skills/git-commits-push/src/modules/git/git-exec.${extension}:1:1)`,
			),
			true,
		);
		assert.equal(
			trustStore.isAuthorizedTrustTokenIssuerStack(
				`at trustedGitEnv (/workspace/skills/git-commits-push/src/utils/git-utils.${extension}:1:1)`,
			),
			true,
		);
	}
	for (const extension of ["ts", "js"]) {
		assert.equal(
			trustStore.isAuthorizedTrustTokenIssuerStack(
				`at forged (/workspace/skills/git-commits-push/src/utils/git-utils.${extension}.lookalike:1:1)`,
			),
			false,
		);
	}
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
			assert.equal(trustStore.validateTrustToken(token), true);
			assert.equal(trustStore.validateTrustToken(token), false);
			await assert.rejects(readFile(tokenPath), { code: "ENOENT" });
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
