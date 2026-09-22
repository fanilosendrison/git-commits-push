// tests/unit/invocation-scope-resolution.test.ts — Unit tests for canonical
// invocation-scope resolution and persisted-scope revalidation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import {
	assertInvocationScopeCurrent,
	GLOBAL_INVOCATION_SCOPE,
	resolveInvocationScope,
} from "../../src/modules/invocation/invocation-scope.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";

interface BareRemoteFixture {
	readonly remoteRoot: string;
	readonly remotePath: string;
}

function createBareRemote(): BareRemoteFixture {
	const remoteRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "invocation-scope-remote-"),
	);
	const remotePath = path.join(remoteRoot, "remote.git");
	execFileSync("git", ["init", "--bare", remotePath]);
	return { remoteRoot, remotePath };
}

function createRepositoryWithOrigin(): {
	readonly repo: GitRepoFixture;
	readonly remote: BareRemoteFixture;
} {
	const remote = createBareRemote();
	const repo = GitRepoFixture.create();
	repo.commit("initial");
	repo.setRemote("origin", remote.remotePath);
	return { repo, remote };
}

function disposeRepositoryWithOrigin(
	repo: GitRepoFixture,
	remote: BareRemoteFixture,
): void {
	repo.dispose();
	fs.rmSync(remote.remoteRoot, { recursive: true, force: true });
}

describe("U-IS-07 | exact worktree root success", () => {
	let repo: GitRepoFixture;
	let remote: BareRemoteFixture;

	before(() => {
		({ repo, remote } = createRepositoryWithOrigin());
	});
	after(() => disposeRepositoryWithOrigin(repo, remote));

	test("resolves a frozen canonical targeted scope", () => {
		const scope = resolveInvocationScope({
			kind: "targeted",
			repository: repo.dir,
			pushRemote: "origin",
			pushRef: "refs/heads/main",
		});

		assert.deepStrictEqual(scope, {
			kind: "targeted",
			repository: fs.realpathSync(repo.dir),
			pushRemote: "origin",
			pushRef: "refs/heads/main",
		});
		assert.ok(Object.isFrozen(scope));
	});
});

describe("U-IS-08 | child directory rejection", () => {
	let repo: GitRepoFixture;
	let remote: BareRemoteFixture;

	before(() => {
		({ repo, remote } = createRepositoryWithOrigin());
		fs.mkdirSync(path.join(repo.dir, "nested"));
	});
	after(() => disposeRepositoryWithOrigin(repo, remote));

	test("rejects a child path instead of promoting it to the repository root", () => {
		assert.throws(
			() =>
				resolveInvocationScope({
					kind: "targeted",
					repository: path.join(repo.dir, "nested"),
					pushRemote: "origin",
					pushRef: "refs/heads/main",
				}),
			/exact Git worktree root/,
		);
	});
});

describe("U-IS-09 | missing repository", () => {
	test("rejects an absolute nonexistent path", () => {
		const missing = path.join(
			os.tmpdir(),
			`invocation-scope-missing-${Date.now()}`,
		);
		assert.throws(
			() =>
				resolveInvocationScope({
					kind: "targeted",
					repository: missing,
					pushRemote: "origin",
					pushRef: "refs/heads/main",
				}),
			/does not exist or cannot be resolved/,
		);
	});
});

describe("U-IS-10 | missing configured remote", () => {
	let repo: GitRepoFixture;

	before(() => {
		repo = GitRepoFixture.create();
		repo.commit("initial");
	});
	after(() => repo.dispose());

	test("rejects a remote name that is not configured", () => {
		assert.throws(
			() =>
				resolveInvocationScope({
					kind: "targeted",
					repository: repo.dir,
					pushRemote: "origin",
					pushRef: "refs/heads/main",
				}),
			/not a configured Git remote/,
		);
	});
});

describe("U-IS-11 | push ref validation", () => {
	let repo: GitRepoFixture;
	let remote: BareRemoteFixture;

	before(() => {
		({ repo, remote } = createRepositoryWithOrigin());
	});
	after(() => disposeRepositoryWithOrigin(repo, remote));

	test("rejects shorthand and malformed refs", () => {
		for (const pushRef of [
			"main",
			"origin/main",
			"refs/heads/",
			"refs/heads/bad..name",
		]) {
			assert.throws(
				() =>
					resolveInvocationScope({
						kind: "targeted",
						repository: repo.dir,
						pushRemote: "origin",
						pushRef,
					}),
				(error: unknown) =>
					error instanceof Error && error.message.includes("refs/heads/"),
			);
		}
	});

	test("accepts a fully qualified branch ref", () => {
		const scope = resolveInvocationScope({
			kind: "targeted",
			repository: repo.dir,
			pushRemote: "origin",
			pushRef: "refs/heads/feature/thing",
		});

		assert.strictEqual(
			scope.kind === "targeted" ? scope.pushRef : null,
			"refs/heads/feature/thing",
		);
	});
});

describe("U-IS-12 | detached target", () => {
	let repo: GitRepoFixture;
	let remote: BareRemoteFixture;

	before(() => {
		({ repo, remote } = createRepositoryWithOrigin());
		repo.checkoutDetached();
	});
	after(() => disposeRepositoryWithOrigin(repo, remote));

	test("resolves a detached HEAD worktree without requiring a symbolic HEAD", () => {
		const scope = resolveInvocationScope({
			kind: "targeted",
			repository: repo.dir,
			pushRemote: "origin",
			pushRef: "refs/heads/main",
		});

		assert.deepStrictEqual(scope, {
			kind: "targeted",
			repository: fs.realpathSync(repo.dir),
			pushRemote: "origin",
			pushRef: "refs/heads/main",
		});
	});
});

describe("U-IS-13 | persisted scope revalidation", () => {
	let repo: GitRepoFixture;
	let remote: BareRemoteFixture;

	before(() => {
		({ repo, remote } = createRepositoryWithOrigin());
	});
	after(() => {
		repo.dispose();
		fs.rmSync(remote.remoteRoot, { recursive: true, force: true });
	});

	test("accepts a current scope and rejects a removed worktree", () => {
		const scope = resolveInvocationScope({
			kind: "targeted",
			repository: repo.dir,
			pushRemote: "origin",
			pushRef: "refs/heads/main",
		});

		assert.doesNotThrow(() => assertInvocationScopeCurrent(scope));

		const movedPath = `${repo.dir}-moved`;
		fs.renameSync(repo.dir, movedPath);
		try {
			assert.throws(
				() => assertInvocationScopeCurrent(scope),
				/does not exist or cannot be resolved/,
			);
		} finally {
			fs.renameSync(movedPath, repo.dir);
		}
	});

	test("treats global scope as a no-op", () => {
		assert.doesNotThrow(() =>
			assertInvocationScopeCurrent(GLOBAL_INVOCATION_SCOPE),
		);
	});
});
