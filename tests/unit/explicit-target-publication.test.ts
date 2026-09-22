// tests/unit/explicit-target-publication.test.ts — Explicit-target publication
// against real temporary repositories and real bare remotes.
//
// Proves the frozen-target boundary: the named remote and ref are the whole
// publication authority, the observed baseline is frozen before any commit
// effect, a moved destination fails closed without converging, and no branch,
// upstream, tracking-ref, or persistent Git configuration is mutated.
// The detached commit-and-publish path is proven end-to-end by acceptance A7.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import { runDiscovery } from "../../src/modules/core/discovery.ts";
import { PushError } from "../../src/modules/core/errors.ts";
import {
	buildExplicitPushSnapshot,
	publishExactExplicitTarget,
	publishExplicitTargetSnapshot,
	validateAndPushExplicitSnapshot,
} from "../../src/modules/git/explicit-push.ts";
import { captureExplicitPushTargetSnapshot } from "../../src/modules/git/explicit-push-target.ts";
import {
	type ResolvedPushEndpoint,
	resolveSinglePushEndpoint,
} from "../../src/modules/git/push-endpoint.ts";
import { resolveInvocationScope } from "../../src/modules/invocation/invocation-scope.ts";
import type { ExplicitPushSnapshot, Settings } from "../../src/types.ts";
import { GitRepoFixture } from "../fixtures/git-repo.ts";

const SETTINGS: Settings = {
	searchPaths: [],
	provider: "mistral",
	model: "mistral-medium-3.5",
	temperature: 0,
	systemPromptPath: "/dev/null",
	// autoPush governs global discovery only, so every assertion below must hold
	// with it disabled.
	autoPush: false,
	skipTests: true,
};

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
});

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}
function createBareRemote(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const barePath = path.join(root, "remote.git");
	execFileSync("git", ["init", "--bare", barePath], { stdio: "pipe" });
	cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
	return barePath;
}

interface ExplicitFixture {
	readonly dir: string;
	readonly remotePath: string;
	readonly branch: string;
	readonly baseline: string;
	readonly destinationRef: string;
}

/** A detached task worktree whose upstream branch already exists on the remote. */
function createFixture(): ExplicitFixture {
	const remotePath = createBareRemote("explicit-remote-");
	const repo = GitRepoFixture.create();
	repo.commit("initial");
	repo.setRemote("origin", remotePath);
	const branch = git(repo.dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	git(repo.dir, ["push", "--set-upstream", "origin", branch]);
	const baseline = git(repo.dir, ["rev-parse", "HEAD"]);
	repo.checkoutDetached();
	cleanup.push(() => repo.dispose());
	return {
		dir: repo.dir,
		remotePath,
		branch,
		baseline,
		destinationRef: `refs/heads/${branch}`,
	};
}

function isDetached(repository: string): boolean {
	try {
		git(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
		return false;
	} catch {
		return true;
	}
}

function addDetachedCommit(fixture: ExplicitFixture, file: string): string {
	fs.writeFileSync(
		path.join(fixture.dir, file),
		`export const ${file.replaceAll(".", "_")} = true;\n`,
	);
	git(fixture.dir, ["add", "-A"]);
	git(fixture.dir, ["commit", "--no-verify", "-m", `add ${file}`]);
	return git(fixture.dir, ["rev-parse", "HEAD"]);
}

function targetScope(fixture: ExplicitFixture) {
	return resolveInvocationScope({
		kind: "targeted",
		repository: fixture.dir,
		pushRemote: "origin",
		pushRef: fixture.destinationRef,
	});
}

function freeze(
	fixture: ExplicitFixture,
	destinationRef = fixture.destinationRef,
	remote = "origin",
) {
	return captureExplicitPushTargetSnapshot(fixture.dir, {
		remote,
		destinationRef,
	});
}

function explicitSnapshot(fixture: ExplicitFixture): ExplicitPushSnapshot {
	const snapshot = buildExplicitPushSnapshot(fixture.dir, freeze(fixture));
	assert.ok(snapshot, "expected a clean ahead worktree to yield a snapshot");
	return snapshot;
}

function repositoryInfo(fixture: ExplicitFixture) {
	return { id: "repo", path: fixture.dir };
}

const passingScanner = async () => ({ hasSecrets: false, matchCount: 0 });

/** Assert a fail-closed, non-transient publication diagnostic. */
function assertNonTransient(operation: () => unknown, pattern: RegExp): void {
	assert.throws(operation, (error: unknown) => {
		assert.ok(error instanceof PushError);
		assert.strictEqual(error.transient, false);
		assert.match(error.message, pattern);
		return true;
	});
}

async function assertRejectedNonTransient(
	operation: Promise<unknown>,
	...patterns: RegExp[]
): Promise<void> {
	await assert.rejects(operation, (error: unknown) => {
		assert.ok(error instanceof PushError);
		assert.strictEqual(error.transient, false);
		for (const pattern of patterns) assert.match(error.message, pattern);
		return true;
	});
}

/** Publish one unrelated commit to the shared remote, moving the destination. */
function advanceRemote(fixture: ExplicitFixture): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "explicit-clone-"));
	try {
		const clonePath = path.join(root, "clone");
		execFileSync("git", ["clone", fixture.remotePath, clonePath], {
			stdio: "pipe",
		});
		git(clonePath, ["config", "user.email", "test@example.com"]);
		git(clonePath, ["config", "user.name", "Test"]);
		fs.writeFileSync(
			path.join(clonePath, "concurrent.ts"),
			"export const concurrent = true;\n",
		);
		git(clonePath, ["add", "concurrent.ts"]);
		git(clonePath, ["commit", "--no-verify", "-m", "concurrent"]);
		git(clonePath, ["push", "origin", `HEAD:${fixture.destinationRef}`]);
		return git(clonePath, ["rev-parse", "HEAD"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function remoteHead(fixture: ExplicitFixture): string {
	return git(fixture.remotePath, ["rev-parse", fixture.branch]);
}

function publishSnapshot(
	fixture: ExplicitFixture,
	snapshot: ExplicitPushSnapshot,
) {
	return validateAndPushExplicitSnapshot(
		repositoryInfo(fixture),
		snapshot,
		SETTINGS,
		passingScanner,
	);
}

describe("explicit-target publication", () => {
	test("E1 | the named remote and ref are the destination authority", () => {
		const fixture = createFixture();
		git(fixture.dir, ["push", "origin", "HEAD:refs/heads/target"]);
		const targetSha = git(fixture.dir, ["rev-parse", "HEAD"]);
		git(fixture.dir, ["config", "push.default", "current"]);
		git(fixture.dir, ["config", "remote.pushDefault", "origin"]);
		git(fixture.dir, [
			"config",
			`branch.${fixture.branch}.pushRemote`,
			"origin",
		]);
		const snapshot = freeze(fixture, "refs/heads/target");
		assert.strictEqual(snapshot.remote, "origin");
		assert.strictEqual(snapshot.destinationRef, "refs/heads/target");
		assert.strictEqual(snapshot.destinationBaselineSha, targetSha);
		assert.notStrictEqual(snapshot.destinationRef, fixture.destinationRef);
		assert.ok(!JSON.stringify(snapshot).includes("https://"));
		const rejected: Array<[string, string, RegExp]> = [
			[fixture.destinationRef, ".", /configured Git remote/u],
			[fixture.branch, "origin", /refs\/heads\//u],
		];
		for (const [destinationRef, remote, pattern] of rejected) {
			assert.throws(() => freeze(fixture, destinationRef, remote), pattern);
		}
	});

	test("E2 | a missing destination branch fails closed without pushing", () => {
		const fixture = createFixture();
		assertNonTransient(
			() => freeze(fixture, "refs/heads/absent"),
			/does not exist on remote/u,
		);
		assert.strictEqual(
			git(fixture.remotePath, [
				"for-each-ref",
				"--format=%(refname)",
				"refs/heads",
			]),
			fixture.destinationRef,
		);
	});

	test("E3 | a changed push URL invalidates the frozen endpoint", () => {
		const fixture = createFixture();
		const frozen = freeze(fixture);
		const otherPath = createBareRemote("explicit-other-remote-");
		git(fixture.dir, ["remote", "set-url", "--push", "origin", otherPath]);
		const head = addDetachedCommit(fixture, "e3.ts");
		assertNonTransient(
			() => publishExplicitTargetSnapshot(fixture.dir, frozen, head),
			/push URL changed/u,
		);
		assert.strictEqual(remoteHead(fixture), fixture.baseline);
	});

	test("E4 | a clean detached worktree publishes exact push-only", async () => {
		const fixture = createFixture();
		const head = addDetachedCommit(fixture, "e4.ts");
		const discovered = await runDiscovery(SETTINGS, targetScope(fixture));
		assert.strictEqual(discovered.length, 1);
		assert.strictEqual(discovered[0]?.operation, "push-only");
		const snapshot = discovered[0]?.pushSnapshot;
		assert.strictEqual(snapshot?.kind, "explicit");
		if (snapshot?.kind !== "explicit") return;
		assert.deepStrictEqual(
			{ ...snapshot, pushUrlFingerprint: undefined },
			{
				kind: "explicit",
				validatedHeadSha: head,
				remote: "origin",
				destinationRef: fixture.destinationRef,
				destinationBaselineSha: fixture.baseline,
				outgoingShas: [head],
				pushUrlFingerprint: undefined,
			},
		);
		assert.match(snapshot.pushUrlFingerprint, /^[a-f0-9]{64}$/u);
		const publication = await publishSnapshot(fixture, snapshot);
		assert.deepStrictEqual(publication.pushedShas, [head]);
		assert.strictEqual(publication.publishedSha, head);
		assert.strictEqual(
			publication.remoteTrackingRefSynchronization,
			"not-applicable",
		);
		assert.strictEqual(remoteHead(fixture), head);
		assert.strictEqual(isDetached(fixture.dir), true);
		// Explicit publication owns no local branch or tracking projection.
		const trackingRef = `refs/remotes/origin/${fixture.branch}`;
		assert.strictEqual(
			git(fixture.dir, ["rev-parse", trackingRef]),
			fixture.baseline,
		);
		assert.strictEqual(
			git(fixture.dir, ["rev-parse", fixture.destinationRef]),
			fixture.baseline,
		);
	});

	test("E5 | a worktree already at the destination produces no work", async () => {
		const fixture = createFixture();
		assert.deepStrictEqual(
			await runDiscovery(SETTINGS, targetScope(fixture)),
			[],
		);
		assert.strictEqual(remoteHead(fixture), fixture.baseline);
	});

	test("E6 | a diverged destination fails closed", async () => {
		const fixture = createFixture();
		const head = addDetachedCommit(fixture, "e6.ts");
		const advanced = advanceRemote(fixture);
		await assertRejectedNonTransient(
			runDiscovery(SETTINGS, targetScope(fixture)),
			/diverged/u,
			/outside git-commits-push/u,
		);
		assert.strictEqual(remoteHead(fixture), advanced);
		assert.strictEqual(git(fixture.dir, ["rev-parse", "HEAD"]), head);
	});

	test("E7 | a destination that moves after the snapshot fails non-transiently", async () => {
		const fixture = createFixture();
		const head = addDetachedCommit(fixture, "e7.ts");
		const snapshot = explicitSnapshot(fixture);
		const advanced = advanceRemote(fixture);
		await assertRejectedNonTransient(
			publishSnapshot(fixture, snapshot),
			/no longer matches the frozen baseline/u,
			new RegExp(advanced),
		);
		assert.strictEqual(remoteHead(fixture), advanced);
		assert.strictEqual(git(fixture.dir, ["rev-parse", "HEAD"]), head);
	});

	test("E8 | publication leaves persistent Git configuration unchanged", async () => {
		const fixture = createFixture();
		const head = addDetachedCommit(fixture, "e8.ts");
		const before = git(fixture.dir, ["config", "--local", "--list"]);
		await publishSnapshot(fixture, explicitSnapshot(fixture));
		const after = git(fixture.dir, ["config", "--local", "--list"]);
		assert.strictEqual(after, before);
		for (const key of [
			"remote.pushDefault",
			"push.default",
			"extensions.worktreeConfig",
		]) {
			assert.strictEqual(after.includes(key), before.includes(key));
		}
		assert.strictEqual(remoteHead(fixture), head);
	});

	test("E9 | an uncertain push reads the real destination instead of republishing", () => {
		const fixture = createFixture();
		const head = addDetachedCommit(fixture, "e9.ts");
		const real = resolveSinglePushEndpoint(fixture.dir, "origin");
		let pushAttempts = 0;
		// The remote accepts the update, then the transport result becomes uncertain.
		const uncertainEndpoint: ResolvedPushEndpoint = {
			fingerprint: real.fingerprint,
			readDestinationSha: (ref) => real.readDestinationSha(ref),
			readOptionalDestinationSha: (ref) => real.readOptionalDestinationSha(ref),
			pushExact: (sourceSha, destinationRef, baseline) => {
				real.pushExact(sourceSha, destinationRef, baseline);
				pushAttempts += 1;
				if (pushAttempts === 1) {
					throw new Error("transport failed after accepting the update");
				}
			},
		};
		const publication = publishExactExplicitTarget(
			fixture.dir,
			uncertainEndpoint,
			fixture.destinationRef,
			fixture.baseline,
			head,
		);
		assert.strictEqual(publication.publishedSha, head);
		assert.strictEqual(publication.retryCount, 1);
		assert.strictEqual(pushAttempts, 1);
		assert.strictEqual(remoteHead(fixture), head);
	});

	test("inter-worktree collision rejects a superseded task", async () => {
		const fixture = createFixture();
		const taskCHead = addDetachedCommit(fixture, "task-c.ts");
		const snapshotC = explicitSnapshot(fixture);
		const taskBHead = advanceRemote(fixture);
		await assertRejectedNonTransient(publishSnapshot(fixture, snapshotC));
		assert.strictEqual(remoteHead(fixture), taskBHead);
		assert.strictEqual(git(fixture.dir, ["rev-parse", "HEAD"]), taskCHead);
		assert.strictEqual(isDetached(fixture.dir), true);
		for (const state of ["MERGE_HEAD", "REBASE_HEAD"]) {
			assert.throws(() => git(fixture.dir, ["rev-parse", "--verify", state]));
		}
	});
});
