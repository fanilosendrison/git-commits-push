import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { runDiscovery } from "../../src/modules/core/discovery.ts";
import { buildExplicitCreatePushSnapshot } from "../../src/modules/git/explicit-create-push.ts";
import { assertExplicitCreateTargetCurrent } from "../../src/modules/git/explicit-create-target.ts";
import {
	publishExactExplicitTarget,
	validateAndPushExplicitSnapshot,
} from "../../src/modules/git/explicit-push.ts";
import { parseRemoteRefObservation } from "../../src/modules/git/git-object-id.ts";
import {
	type ResolvedPushEndpoint,
	resolveSinglePushEndpoint,
} from "../../src/modules/git/push-endpoint.ts";
import {
	parseInvocationArguments,
	resolveInvocationScope,
} from "../../src/modules/invocation/invocation-scope.ts";
import {
	CREATE_SETTINGS,
	createFixture,
	git,
} from "../fixtures/targeted-create.ts";

const ref = "refs/heads/task";
test("C05 C06 | only successful exact, complete, unambiguous remote records establish identity/absence", () => {
	const sha = "a".repeat(40);
	assert.equal(parseRemoteRefObservation("", ref), null);
	assert.equal(parseRemoteRefObservation(`${sha}\t${ref}\n`, ref), sha);
	for (const output of [
		"\n",
		`${sha} ${ref}\n`,
		`${sha}\t${ref}`,
		`${sha}\trefs/heads/other\n`,
		`${sha}\t${ref}\n${sha}\t${ref}\n`,
		`${"0".repeat(40)}\t${ref}\n`,
		`invalid\t${ref}\n`,
		`${sha}\t${ref}\ntruncated`,
	])
		assert.throws(() => parseRemoteRefObservation(output, ref));
});

test("C04 C07 | base/ref/remote prerequisites fail without creating local history", async () => {
	const f = createFixture();
	try {
		const blob = git(f.repo.dir, ["hash-object", "-w", ".gitkeep"]);
		git(f.repo.dir, ["tag", "-a", "base-tag", "-m", "tag"]);
		const tag = git(f.repo.dir, ["rev-parse", "refs/tags/base-tag"]);
		for (const sha of [
			f.baseSha.slice(0, 12),
			"0".repeat(40),
			"bad",
			blob,
			tag,
			"b".repeat(40),
			"a".repeat(64),
		]) {
			const args = [...f.args.slice(0, -1), sha];
			assert.throws(
				() => resolveInvocationScope(parseInvocationArguments(args).request),
				/commit|prerequisite|object/u,
			);
		}
		for (const [flag, value] of [
			["--base-ref", ref],
			["--base-ref", "main"],
			["--push-ref", "refs/tags/task"],
			["--push-remote", "missing"],
			["--push-remote", "."],
		]) {
			const args = [...f.args];
			const index = args.indexOf(flag ?? "");
			args[index + 1] = value ?? "";
			assert.throws(() =>
				resolveInvocationScope(parseInvocationArguments(args).request),
			);
		}
		// A remote source not locally present is a prerequisite failure, not a fetch.
		const prior = f.commit();
		git(f.repo.dir, ["push", "origin", `${prior}:refs/heads/source`]);
		const object = git(f.repo.dir, ["rev-parse", `${prior}^{tree}`]);
		git(f.repo.dir, ["checkout", "--detach", f.baseSha]);
		const objectPath = path.join(
			f.repo.dir,
			".git",
			"objects",
			prior.slice(0, 2),
			prior.slice(2),
		);
		fs.unlinkSync(objectPath);
		await assert.rejects(
			runDiscovery(CREATE_SETTINGS, f.scope()),
			/prerequisite|local commit/u,
		);
		assert.equal(git(f.repo.dir, ["rev-parse", "HEAD"]), f.baseSha);
		assert.ok(object);
	} finally {
		f.repo.dispose();
	}
});

test("C07 C08 C09 C14 | ancestry and admission absence are independent of source progression", async () => {
	const f = createFixture();
	try {
		const advanced = f.commit();
		git(f.repo.dir, ["push", "origin", `${advanced}:refs/heads/source`]);
		git(f.repo.dir, ["checkout", "--detach", f.baseSha]);
		fs.writeFileSync(path.join(f.repo.dir, "dirty.txt"), "dirty\n");
		const [repo] = await runDiscovery(CREATE_SETTINGS, f.scope());
		const target = repo?.explicitPushTargetSnapshot;
		assert.ok(target && "kind" in target);
		assert.equal(target.baseSha, f.baseSha);
		assert.equal(target.observedBaseRefSha, advanced);
		assert.equal(
			target.initialHeadSha,
			f.baseSha,
			"an older authorized task base remains admissible",
		);
		// Source progression/deletion after admission is not a publication lock.
		git(f.remote, ["update-ref", "-d", "refs/heads/source"]);
		assertExplicitCreateTargetCurrent(f.repo.dir, target);
		git(f.repo.dir, ["push", "origin", `${f.baseSha}:${ref}`]);
		assert.throws(
			() => assertExplicitCreateTargetCurrent(f.repo.dir, target),
			/appeared/u,
		);
		assert.equal(
			fs.readFileSync(path.join(f.repo.dir, "dirty.txt"), "utf8"),
			"dirty\n",
		);
	} finally {
		f.repo.dispose();
	}
});

test("C15 C16 C17 C18 C19 C24 | races and uncertain outcomes retain the absence lease and same S", () => {
	const f = createFixture();
	try {
		const source = f.commit();
		const real = resolveSinglePushEndpoint(f.repo.dir, "origin");
		for (const mode of [
			"accepted-error",
			"retry-absent",
			"race-other",
			"race-same",
			"unobservable",
			"postflight-other",
		] as const) {
			git(f.remote, ["update-ref", "-d", ref]);
			let attempts = 0;
			const endpoint: ResolvedPushEndpoint = {
				fingerprint: real.fingerprint,
				readDestinationSha: (r) => real.readDestinationSha(r),
				readOptionalDestinationSha: (r) => {
					if (mode === "unobservable" && attempts > 0)
						throw new Error("transport unavailable");
					return real.readOptionalDestinationSha(r);
				},
				pushExact: (sha, r, expected) => {
					attempts++;
					assert.equal(sha, source);
					assert.equal(r, ref);
					assert.equal(expected, null);
					if (mode === "race-other")
						git(f.repo.dir, ["push", "origin", `${f.baseSha}:${ref}`]);
					if (mode === "race-same")
						git(f.repo.dir, ["push", "origin", `${source}:${ref}`]);
					if (
						mode === "unobservable" ||
						(mode === "retry-absent" && attempts === 1)
					)
						throw new Error("network timeout");
					real.pushExact(sha, r, expected);
					if (mode === "postflight-other")
						git(f.remote, ["update-ref", ref, f.baseSha]);
					if (mode === "accepted-error")
						throw new Error("network timeout after acceptance");
				},
			};
			const publish = () =>
				publishExactExplicitTarget(f.repo.dir, endpoint, ref, null, source);
			if (["race-other", "unobservable", "postflight-other"].includes(mode))
				assert.throws(publish);
			else assert.equal(publish().publishedSha, source);
			assert.equal(attempts, mode === "retry-absent" ? 2 : 1);
			if (mode === "race-other")
				assert.equal(git(f.remote, ["rev-parse", ref]), f.baseSha);
		}
	} finally {
		f.repo.dispose();
	}
});

test("C07 | both observed source and initial HEAD must descend from B", async () => {
	const f = createFixture();
	try {
		const newer = f.commit();
		const newerArgs = [...f.args.slice(0, -1), newer];
		const newerScope = resolveInvocationScope(
			parseInvocationArguments(newerArgs).request,
		);
		await assert.rejects(
			runDiscovery(CREATE_SETTINGS, newerScope),
			/not an ancestor/u,
		);
		git(f.repo.dir, ["push", "origin", `${newer}:refs/heads/source`]);
		git(f.repo.dir, ["checkout", "--detach", f.baseSha]);
		await assert.rejects(
			runDiscovery(CREATE_SETTINGS, newerScope),
			/not an ancestor/u,
		);
	} finally {
		f.repo.dispose();
	}
});

test("C05 C32 | unreadable transport never establishes absence, and diagnostics redact credentials", async () => {
	const f = createFixture();
	try {
		git(f.repo.dir, [
			"remote",
			"set-url",
			"--push",
			"origin",
			path.join(f.repo.dir, ".git", "missing.git"),
		]);
		await assert.rejects(
			runDiscovery(CREATE_SETTINGS, f.scope()),
			/Cannot verify/u,
		);
		const endpoint: ResolvedPushEndpoint = {
			fingerprint: "f".repeat(64),
			readDestinationSha: () => {
				throw new Error("unreadable");
			},
			readOptionalDestinationSha: () => {
				throw new Error(
					"cannot read https://actor:credential-value@host.invalid/repo?access_token=private-value",
				);
			},
			pushExact: () =>
				assert.fail("unobservable destination cannot authorize publication"),
		};
		assert.throws(
			() =>
				publishExactExplicitTarget(f.repo.dir, endpoint, ref, null, f.baseSha),
			(error) => {
				assert.ok(error instanceof Error);
				assert.ok(!error.message.includes("credential-value"));
				assert.ok(!error.message.includes("private-value"));
				return true;
			},
		);
	} finally {
		f.repo.dispose();
	}
});

test("C23 | configured on-demand submodule push cannot publish a secondary repository", async () => {
	const f = createFixture();
	const child = createFixture();
	try {
		git(child.remote, ["symbolic-ref", "HEAD", "refs/heads/source"]);
		git(f.repo.dir, [
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			child.remote,
			"child",
		]);
		f.repo.commit("add submodule");
		const modulePath = path.join(f.repo.dir, "child");
		git(modulePath, ["config", "user.name", "Fixture"]);
		git(modulePath, ["config", "user.email", "fixture@example.invalid"]);
		fs.writeFileSync(path.join(modulePath, "new.txt"), "not published\n");
		git(modulePath, ["add", "new.txt"]);
		git(modulePath, ["commit", "--no-verify", "-m", "feat: child"]);
		f.repo.commit("update gitlink");
		git(f.repo.dir, ["config", "push.recurseSubmodules", "on-demand"]);
		git(f.repo.dir, ["config", "diff.submodule", "diff"]);
		git(f.repo.dir, ["config", "diff.ignoreSubmodules", "all"]);
		const [repo] = await runDiscovery(CREATE_SETTINGS, f.scope());
		assert.ok(repo?.pushSnapshot?.kind === "explicit-create");
		await validateAndPushExplicitSnapshot(
			repo,
			repo.pushSnapshot,
			CREATE_SETTINGS,
		);
		assert.equal(
			git(f.remote, ["rev-parse", ref]),
			git(f.repo.dir, ["rev-parse", "HEAD"]),
		);
		assert.equal(
			git(child.remote, ["rev-parse", "refs/heads/source"]),
			child.baseSha,
		);
	} finally {
		f.repo.dispose();
		child.repo.dispose();
	}
});

for (const mutation of ["worktree", "head", "endpoint", "outgoing"] as const)
	test(`C20 | ${mutation} changes during asynchronous scanning refuse publication`, async () => {
		const f = createFixture();
		try {
			fs.writeFileSync(path.join(f.repo.dir, "dirty.txt"), "dirty\n");
			const [repo] = await runDiscovery(CREATE_SETTINGS, f.scope());
			const target = repo?.explicitPushTargetSnapshot;
			assert.ok(target && "kind" in target);
			fs.unlinkSync(path.join(f.repo.dir, "dirty.txt"));
			const snapshot = buildExplicitCreatePushSnapshot(f.repo.dir, target);
			await assert.rejects(
				validateAndPushExplicitSnapshot(
					{ id: "repo", path: f.repo.dir },
					snapshot,
					CREATE_SETTINGS,
					async () => {
						if (mutation === "worktree")
							fs.writeFileSync(path.join(f.repo.dir, "late.txt"), "late\n");
						else if (mutation === "head") f.commit();
						else if (mutation === "outgoing")
							snapshot.outgoingShas.push(f.baseSha);
						else {
							const other = path.join(f.repo.dir, ".git", "other.git");
							git(f.repo.dir, ["init", "--bare", other]);
							git(f.repo.dir, ["remote", "set-url", "--push", "origin", other]);
						}
						return { hasSecrets: false, matchCount: 0 };
					},
				),
				/changed|outgoing/u,
			);
			assert.equal(
				git(f.remote, ["for-each-ref", "--format=%(objectname)", ref]),
				"",
			);
		} finally {
			f.repo.dispose();
		}
	});
