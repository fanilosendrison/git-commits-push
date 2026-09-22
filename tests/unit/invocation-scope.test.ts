// tests/unit/invocation-scope.test.ts — Unit tests for the invocation-scope
// parser, canonicalization, and persisted-scope revalidation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import {
	assertInvocationScopeCurrent,
	GLOBAL_INVOCATION_SCOPE,
	type InvocationRequest,
	parseInvocationArguments,
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

function targetedRequest(
	repository: string,
	pushRef = "refs/heads/main",
): InvocationRequest {
	return { kind: "targeted", repository, pushRemote: "origin", pushRef };
}

// ─── Pure parser ─────────────────────────────────────────────────────────────

describe("U-IS-01 | global parser", () => {
	test("returns a global request and preserves passthrough arguments", () => {
		const parsed = parseInvocationArguments(["--run-id", "abc"]);

		assert.deepStrictEqual(parsed.request, { kind: "global" });
		assert.deepStrictEqual(
			[...parsed.passthroughArguments],
			["--run-id", "abc"],
		);
	});
});

describe("U-IS-02 | complete targeted parser", () => {
	test("extracts the three raw values and preserves unrelated order", () => {
		const parsed = parseInvocationArguments([
			"--run-id",
			"abc",
			"--repository",
			"/absolute/repo",
			"--push-remote",
			"origin",
			"--push-ref",
			"refs/heads/main",
		]);

		assert.deepStrictEqual(parsed.request, {
			kind: "targeted",
			repository: "/absolute/repo",
			pushRemote: "origin",
			pushRef: "refs/heads/main",
		});
		assert.deepStrictEqual(
			[...parsed.passthroughArguments],
			["--run-id", "abc"],
		);
	});

	test("preserves interleaved passthrough ordering", () => {
		const parsed = parseInvocationArguments([
			"--run-id",
			"abc",
			"--repository",
			"/absolute/repo",
			"--label",
			"batch",
			"--push-remote",
			"origin",
			"--push-ref",
			"refs/heads/main",
		]);

		assert.deepStrictEqual(
			[...parsed.passthroughArguments],
			["--run-id", "abc", "--label", "batch"],
		);
	});
});

describe("U-IS-03 | atomic targeted group", () => {
	const incompleteCases: readonly (readonly string[])[] = [
		["--repository", "/absolute/repo"],
		["--push-remote", "origin"],
		["--push-ref", "refs/heads/main"],
		["--repository", "/absolute/repo", "--push-remote", "origin"],
		["--repository", "/absolute/repo", "--push-ref", "refs/heads/main"],
		["--push-remote", "origin", "--push-ref", "refs/heads/main"],
	];

	for (const args of incompleteCases) {
		test(`rejects incomplete group: ${args.join(" ")}`, () => {
			assert.throws(
				() => parseInvocationArguments(args),
				/all three flags together/,
			);
		});
	}
});

describe("U-IS-04 | duplicate targeted flags", () => {
	test("rejects each duplicated owned flag", () => {
		assert.throws(
			() =>
				parseInvocationArguments([
					"--repository",
					"/a",
					"--repository",
					"/b",
					"--push-remote",
					"origin",
					"--push-ref",
					"refs/heads/main",
				]),
			/Duplicate targeted invocation flag: --repository/,
		);
		assert.throws(
			() =>
				parseInvocationArguments([
					"--repository",
					"/a",
					"--push-remote",
					"origin",
					"--push-remote",
					"upstream",
					"--push-ref",
					"refs/heads/main",
				]),
			/Duplicate targeted invocation flag: --push-remote/,
		);
		assert.throws(
			() =>
				parseInvocationArguments([
					"--repository",
					"/a",
					"--push-remote",
					"origin",
					"--push-ref",
					"refs/heads/main",
					"--push-ref",
					"refs/heads/dev",
				]),
			/Duplicate targeted invocation flag: --push-ref/,
		);
	});
});

describe("U-IS-05 | equals syntax", () => {
	test("rejects --flag=value for each owned flag", () => {
		for (const argument of [
			"--repository=/x",
			"--push-remote=origin",
			"--push-ref=refs/heads/main",
		]) {
			assert.throws(
				() => parseInvocationArguments([argument]),
				/does not accept --flag=value syntax/,
			);
		}
	});
});

describe("U-IS-06 | resume", () => {
	test("rejects targeted flags combined with --resume", () => {
		assert.throws(
			() =>
				parseInvocationArguments([
					"--resume",
					"--repository",
					"/absolute/repo",
					"--push-remote",
					"origin",
					"--push-ref",
					"refs/heads/main",
				]),
			/resume uses the persisted invocation scope/,
		);
	});

	test("passes global resume arguments through unchanged", () => {
		const parsed = parseInvocationArguments(["--resume", "--run-id", "X"]);

		assert.deepStrictEqual(parsed.request, { kind: "global" });
		assert.deepStrictEqual(
			[...parsed.passthroughArguments],
			["--resume", "--run-id", "X"],
		);
	});
});

// ─── Canonical resolution ────────────────────────────────────────────────────

describe("U-IS-07 | exact worktree root success", () => {
	let repo: GitRepoFixture;
	let remote: BareRemoteFixture;

	before(() => {
		({ repo, remote } = createRepositoryWithOrigin());
	});
	after(() => disposeRepositoryWithOrigin(repo, remote));

	test("resolves a frozen canonical targeted scope", () => {
		const scope = resolveInvocationScope(targetedRequest(repo.dir));

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
				resolveInvocationScope(targetedRequest(path.join(repo.dir, "nested"))),
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
			() => resolveInvocationScope(targetedRequest(missing)),
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
			() => resolveInvocationScope(targetedRequest(repo.dir)),
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
				() => resolveInvocationScope(targetedRequest(repo.dir, pushRef)),
				(error: unknown) =>
					error instanceof Error && error.message.includes("refs/heads/"),
			);
		}
	});

	test("accepts a fully qualified branch ref", () => {
		const scope = resolveInvocationScope(
			targetedRequest(repo.dir, "refs/heads/feature/thing"),
		);

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
		const scope = resolveInvocationScope(targetedRequest(repo.dir));

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
		const scope = resolveInvocationScope(targetedRequest(repo.dir));

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
