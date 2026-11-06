import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { runDiscovery } from "../../src/modules/core/discovery.ts";
import { validateAndPushExplicitSnapshot } from "../../src/modules/git/explicit-push.ts";
import {
	parseInvocationArguments,
	resolveInvocationScope,
} from "../../src/modules/invocation/invocation-scope.ts";
import {
	CREATE_SETTINGS,
	createFixture,
	git,
} from "../fixtures/targeted-create.ts";

for (const boundary of ["shallow", "graft", "ambient-graft"] as const)
	for (const mode of ["secret", "safe", "missing-parent"] as const)
		test(`C07 C21 | ${boundary} merged side ${mode} uses actual outgoing history`, async () => {
			const f = createFixture();
			const previousTrace = process.env.GIT_TRACE;
			const previousGraft = process.env.GIT_GRAFT_FILE;
			try {
				const U = f.commit(
					"credentials.txt",
					mode === "secret"
						? `OPENAI_API_KEY=sk-${"A".repeat(48)}\n`
						: "safe side content\n",
				);
				const T = f.commit("credentials.txt", "safe final content\n");
				git(f.repo.dir, ["push", "origin", `${T}:refs/heads/retained-side`]);
				const tree = git(f.repo.dir, ["rev-parse", `${T}^{tree}`]);
				const S = git(f.repo.dir, [
					"commit-tree",
					tree,
					"-p",
					f.baseSha,
					"-p",
					T,
					"-m",
					"Merge side history",
				]);
				git(f.repo.dir, ["reset", "--hard", S]);
				const shallow = path.resolve(
					f.repo.dir,
					git(f.repo.dir, [
						"rev-parse",
						"--git-path",
						boundary === "shallow"
							? "shallow"
							: boundary === "graft"
								? "info/grafts"
								: "custom-grafts",
					]),
				);
				fs.writeFileSync(shallow, `${T}\n`);
				if (boundary === "ambient-graft") process.env.GIT_GRAFT_FILE = shallow;
				assert.ok(
					!git(f.repo.dir, ["rev-list", `${f.baseSha}..${S}`])
						.split("\n")
						.includes(U),
				);
				if (mode === "missing-parent")
					fs.unlinkSync(
						path.join(f.repo.dir, ".git", "objects", U.slice(0, 2), U.slice(2)),
					);
				const trace = path.join(f.repo.dir, ".git", "shallow-proof.trace");
				process.env.GIT_TRACE = trace;
				let rejection: unknown;
				try {
					const [repo] = await runDiscovery(CREATE_SETTINGS, f.scope());
					assert.ok(repo?.pushSnapshot?.kind === "explicit-create");
					assert.ok(
						repo.pushSnapshot.outgoingShas.includes(U),
						"actual side ancestor must be in the qualified outgoing set",
					);
					await validateAndPushExplicitSnapshot(
						repo,
						repo.pushSnapshot,
						CREATE_SETTINGS,
					);
				} catch (error) {
					rejection = error;
				}
				assert.equal(
					git(f.remote, [
						"for-each-ref",
						"--format=%(objectname)",
						"refs/heads/task",
					]),
					mode === "safe" ? S : "",
					"publication requires a complete and safe actual outgoing history",
				);
				if (mode === "safe") assert.equal(rejection, undefined);
				else {
					assert.ok(rejection instanceof Error);
					assert.match(
						rejection.message,
						/Secret|Security|prerequisite|shallow/iu,
					);
				}
				assert.equal(git(f.repo.dir, ["rev-parse", "HEAD"]), S);
				assert.equal(fs.readFileSync(shallow, "utf8"), `${T}\n`);
				assert.equal(
					process.env.GIT_GRAFT_FILE,
					boundary === "ambient-graft" ? shallow : previousGraft,
				);
				assert.ok(!/\bfetch\b/u.test(fs.readFileSync(trace, "utf8")));
			} finally {
				if (previousTrace === undefined) delete process.env.GIT_TRACE;
				else process.env.GIT_TRACE = previousTrace;
				if (previousGraft === undefined) delete process.env.GIT_GRAFT_FILE;
				else process.env.GIT_GRAFT_FILE = previousGraft;
				f.repo.dispose();
			}
		});

/** A fully local fixture advertises promisor capability, then advances its source after cloning. */
test("C07 | a missing source commit cannot be lazily fetched from a promisor remote", async () => {
	const f = createFixture();
	const previousTrace = process.env.GIT_TRACE;
	try {
		git(f.remote, ["config", "uploadpack.allowFilter", "true"]);
		const clone = path.join(f.repo.dir, ".git", "promisor-worktree");
		git(f.remote, ["symbolic-ref", "HEAD", "refs/heads/source"]);
		git(f.repo.dir, ["clone", `file://${f.remote}`, clone]);
		git(clone, ["checkout", "--detach", f.baseSha]);
		git(clone, ["config", "core.repositoryformatversion", "1"]);
		git(clone, ["config", "extensions.partialClone", "origin"]);
		git(clone, ["config", "remote.origin.promisor", "true"]);
		git(clone, ["config", "remote.origin.partialclonefilter", "blob:none"]);
		const R = f.commit();
		git(f.repo.dir, ["push", "origin", `${R}:refs/heads/source`]);
		assert.ok(
			!git(clone, [
				"cat-file",
				"--batch-all-objects",
				"--batch-check=%(objectname)",
			])
				.split("\n")
				.includes(R),
		);
		const args = [...f.args];
		args[1] = clone;
		const scope = resolveInvocationScope(
			parseInvocationArguments(args).request,
		);
		const trace = path.join(clone, ".git", "local-proof.trace");
		process.env.GIT_TRACE = trace;
		let rejection: unknown;
		try {
			await runDiscovery(CREATE_SETTINGS, scope);
		} catch (error) {
			rejection = error;
		}
		const traceBytes = fs.existsSync(trace)
			? fs.readFileSync(trace, "utf8")
			: "";
		assert.ok(
			!/\bfetch\b/u.test(traceBytes),
			`local qualification must not invoke fetch:\n${traceBytes}`,
		);
		assert.ok(
			rejection instanceof Error,
			"missing local source proof must reject admission",
		);
		assert.match(rejection.message, /prerequisite|local|object/u);
		assert.ok(
			!git(clone, [
				"cat-file",
				"--batch-all-objects",
				"--batch-check=%(objectname)",
			])
				.split("\n")
				.includes(R),
		);
		// The caller may obtain missing objects separately; the publisher must not reject
		// an otherwise valid promisor repository once the proof objects are local.
		// Use a transport-independent fixture import: legacy Git's experimental
		// promisor fetch is not the publisher behavior being qualified here.
		const bundle = path.join(f.repo.dir, ".git", "proof-objects.bundle");
		git(f.repo.dir, ["bundle", "create", bundle, "HEAD"]);
		git(clone, ["bundle", "unbundle", bundle]);
		fs.writeFileSync(trace, "");
		const [admitted] = await runDiscovery(CREATE_SETTINGS, scope);
		assert.equal(admitted?.pushSnapshot?.kind, "explicit-create");
		assert.equal(admitted?.pushSnapshot?.validatedHeadSha, f.baseSha);
		assert.deepEqual(admitted?.pushSnapshot?.outgoingShas, []);
		assert.ok(!/\bfetch\b/u.test(fs.readFileSync(trace, "utf8")));
	} finally {
		if (previousTrace === undefined) delete process.env.GIT_TRACE;
		else process.env.GIT_TRACE = previousTrace;
		f.repo.dispose();
	}
});

test("C07 C21 | missing outgoing patch objects are refused without lazy fetch", async () => {
	const f = createFixture();
	const previousTrace = process.env.GIT_TRACE;
	try {
		const S = f.commit("work.txt", "outgoing material\n");
		git(f.repo.dir, ["push", "origin", `${S}:refs/heads/cache`]);
		git(f.repo.dir, ["config", "core.repositoryformatversion", "1"]);
		git(f.repo.dir, ["config", "extensions.partialClone", "origin"]);
		git(f.repo.dir, ["config", "remote.origin.promisor", "true"]);
		const blob = git(f.repo.dir, ["rev-parse", `${S}:work.txt`]);
		fs.unlinkSync(
			path.join(f.repo.dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)),
		);
		const trace = path.join(f.repo.dir, ".git", "patch-proof.trace");
		process.env.GIT_TRACE = trace;
		const [repo] = await runDiscovery(CREATE_SETTINGS, f.scope());
		assert.ok(repo?.pushSnapshot?.kind === "explicit-create");
		let rejection: unknown;
		try {
			await validateAndPushExplicitSnapshot(
				repo,
				repo.pushSnapshot,
				CREATE_SETTINGS,
			);
		} catch (error) {
			rejection = error;
		}
		assert.ok(
			!/\bfetch\b/u.test(fs.readFileSync(trace, "utf8")),
			"patch validation must not fetch missing objects",
		);
		assert.ok(rejection instanceof Error);
		assert.match(rejection.message, /prerequisite|local|object/u);
		assert.equal(
			git(f.remote, [
				"for-each-ref",
				"--format=%(objectname)",
				"refs/heads/task",
			]),
			"",
		);
	} finally {
		if (previousTrace === undefined) delete process.env.GIT_TRACE;
		else process.env.GIT_TRACE = previousTrace;
		f.repo.dispose();
	}
});
