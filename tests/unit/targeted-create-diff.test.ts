import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { runDiscovery } from "../../src/modules/core/discovery.ts";
import { processRepoValidationAndDiff } from "../../src/modules/core/validators/pre-commit-validators.ts";
import { validateAndPushExplicitSnapshot } from "../../src/modules/git/explicit-push.ts";
import { executeMultiCommitAndPush } from "../../src/modules/git/publisher.ts";
import {
	parseInvocationArguments,
	resolveInvocationScope,
} from "../../src/modules/invocation/invocation-scope.ts";
import {
	CREATE_SETTINGS,
	createFixture,
	git,
} from "../fixtures/targeted-create.ts";

function observedScope(f: ReturnType<typeof createFixture>, B = f.baseSha) {
	const args = [...f.args];
	args[args.length - 1] = B;
	return resolveInvocationScope(parseInvocationArguments(args).request);
}

function assertAbsent(f: ReturnType<typeof createFixture>) {
	assert.equal(
		git(f.remote, [
			"for-each-ref",
			"--format=%(objectname)",
			"refs/heads/task",
		]),
		"",
	);
}

test("C07 C20 | dirty-at-B qualification refuses a missing baseline blob before staging or lazy fetch", async () => {
	const f = createFixture();
	const previousTrace = process.env.GIT_TRACE;
	try {
		const B = f.commit("work.txt", "before\n");
		git(f.repo.dir, ["push", "origin", `${B}:refs/heads/source`]);
		const blob = git(f.repo.dir, ["rev-parse", `${B}:work.txt`]);
		git(f.repo.dir, ["config", "core.repositoryformatversion", "1"]);
		git(f.repo.dir, ["config", "extensions.partialClone", "origin"]);
		git(f.repo.dir, ["config", "remote.origin.promisor", "true"]);
		fs.unlinkSync(
			path.join(f.repo.dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)),
		);
		fs.writeFileSync(path.join(f.repo.dir, "work.txt"), "after\n");
		const index = fs.readFileSync(path.join(f.repo.dir, ".git", "index"));
		const trace = path.join(f.repo.dir, ".git", "dirty-input.trace");
		process.env.GIT_TRACE = trace;
		const [repo] = await runDiscovery(CREATE_SETTINGS, observedScope(f, B));
		assert.ok(repo);
		await assert.rejects(
			processRepoValidationAndDiff(repo, CREATE_SETTINGS),
			/prerequisite|local|object/u,
		);
		assert.ok(!/\bfetch\b/u.test(fs.readFileSync(trace, "utf8")));
		assert.equal(git(f.repo.dir, ["rev-parse", "HEAD"]), B);
		assert.equal(
			fs.readFileSync(path.join(f.repo.dir, "work.txt"), "utf8"),
			"after\n",
		);
		// Git status may refresh stat metadata, so compare staged contents, not index timestamps.
		assert.ok(index.length > 0);
		assert.equal(
			git(f.repo.dir, ["ls-files", "--stage", "work.txt"]).split(/\s+/u)[1],
			blob,
		);
		assertAbsent(f);
	} finally {
		if (previousTrace === undefined) delete process.env.GIT_TRACE;
		else process.env.GIT_TRACE = previousTrace;
		f.repo.dispose();
	}
});

for (const representation of ["textconv", "binary-attribute", "color"] as const)
	test(`C21 C32 | ${representation} cannot conceal an outgoing production-path secret`, async () => {
		const f = createFixture();
		try {
			if (representation === "textconv") {
				git(f.repo.dir, ["config", "diff.mask.textconv", "printf harmless"]);
				fs.writeFileSync(
					path.join(f.repo.dir, ".gitattributes"),
					"credentials.txt diff=mask\n",
				);
			} else if (representation === "binary-attribute") {
				fs.writeFileSync(
					path.join(f.repo.dir, ".gitattributes"),
					"credentials.txt -diff\n",
				);
			} else git(f.repo.dir, ["config", "color.diff", "always"]);
			fs.writeFileSync(
				path.join(f.repo.dir, "credentials.txt"),
				`OPENAI_API_KEY=sk-${"A".repeat(48)}\n`,
			);
			f.repo.commit("outgoing material");
			const S = git(f.repo.dir, ["rev-parse", "HEAD"]);
			const [repo] = await runDiscovery(CREATE_SETTINGS, f.scope());
			assert.ok(repo?.pushSnapshot?.kind === "explicit-create");
			await assert.rejects(
				validateAndPushExplicitSnapshot(
					repo,
					repo.pushSnapshot,
					CREATE_SETTINGS,
				),
				/Secret|Security/u,
			);
			assert.equal(git(f.repo.dir, ["rev-parse", "HEAD"]), S);
			assertAbsent(f);
		} finally {
			f.repo.dispose();
		}
	});

test("C21 | a masking driver cannot conceal the dirty staged diff before planning", async () => {
	const f = createFixture();
	try {
		git(f.repo.dir, ["config", "diff.mask.textconv", "printf harmless"]);
		fs.writeFileSync(
			path.join(f.repo.dir, ".gitattributes"),
			"credentials.txt diff=mask\n",
		);
		fs.writeFileSync(
			path.join(f.repo.dir, "credentials.txt"),
			`OPENAI_API_KEY=sk-${"A".repeat(48)}\n`,
		);
		const [repo] = await runDiscovery(CREATE_SETTINGS, f.scope());
		assert.ok(repo);
		await assert.rejects(
			processRepoValidationAndDiff(repo, CREATE_SETTINGS),
			/Secret|Security/u,
		);
		assert.equal(git(f.repo.dir, ["rev-parse", "HEAD"]), f.baseSha);
		assertAbsent(f);
	} finally {
		f.repo.dispose();
	}
});

test("C21 | rename detection cannot hide a newly production-path secret", async () => {
	const f = createFixture();
	try {
		fs.mkdirSync(path.join(f.repo.dir, "tests"));
		fs.writeFileSync(
			path.join(f.repo.dir, "tests", "credentials.txt"),
			`OPENAI_API_KEY=sk-${"A".repeat(48)}\n`,
		);
		f.repo.commit("authorized prior history");
		const B = git(f.repo.dir, ["rev-parse", "HEAD"]);
		git(f.repo.dir, ["push", "origin", `${B}:refs/heads/source`]);
		git(f.repo.dir, ["mv", "tests/credentials.txt", "credentials.txt"]);
		f.repo.commit("move material");
		git(f.repo.dir, ["config", "diff.renames", "true"]);
		const [repo] = await runDiscovery(CREATE_SETTINGS, observedScope(f, B));
		assert.ok(repo?.pushSnapshot?.kind === "explicit-create");
		await assert.rejects(
			validateAndPushExplicitSnapshot(repo, repo.pushSnapshot, CREATE_SETTINGS),
			/Secret|Security/u,
		);
		assertAbsent(f);
	} finally {
		f.repo.dispose();
	}
});

test("C21 | log.showRoot cannot hide a new side-history root in B..S", async () => {
	const f = createFixture();
	try {
		f.commit("credentials.txt", `OPENAI_API_KEY=sk-${"A".repeat(48)}\n`);
		const tree = git(f.repo.dir, ["rev-parse", "HEAD^{tree}"]);
		const side = git(f.repo.dir, ["commit-tree", tree, "-m", "side root"]);
		const S = git(f.repo.dir, [
			"commit-tree",
			tree,
			"-p",
			f.baseSha,
			"-p",
			side,
			"-m",
			"merged history",
		]);
		git(f.repo.dir, ["reset", "--hard", S]);
		git(f.repo.dir, ["config", "log.showRoot", "false"]);
		const [repo] = await runDiscovery(CREATE_SETTINGS, f.scope());
		assert.ok(repo?.pushSnapshot?.kind === "explicit-create");
		assert.ok(repo.pushSnapshot.outgoingShas.includes(side));
		await assert.rejects(
			validateAndPushExplicitSnapshot(repo, repo.pushSnapshot, CREATE_SETTINGS),
			/Secret|Security/u,
		);
		assertAbsent(f);
	} finally {
		f.repo.dispose();
	}
});

test("C29 | dirty input qualification never inspects a linked worktree index", async () => {
	const f = createFixture();
	try {
		const foreign = path.join(f.repo.dir, ".git", "foreign-worktree");
		git(f.repo.dir, ["worktree", "add", "--detach", foreign, f.baseSha]);
		fs.writeFileSync(
			path.join(foreign, "foreign.txt"),
			"foreign staged content\n",
		);
		git(foreign, ["add", "foreign.txt"]);
		const blob = git(foreign, ["rev-parse", ":foreign.txt"]);
		fs.unlinkSync(
			path.join(f.repo.dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)),
		);
		const indexPath = path.resolve(
			foreign,
			git(foreign, ["rev-parse", "--git-path", "index"]),
		);
		const before = fs.readFileSync(indexPath);
		fs.writeFileSync(path.join(f.repo.dir, "work.txt"), "owned safe content\n");
		const [repo] = await runDiscovery(CREATE_SETTINGS, f.scope());
		assert.ok(repo);
		const validation = await processRepoValidationAndDiff(
			repo,
			CREATE_SETTINGS,
		);
		assert.ok(validation.diff.includes("owned safe content"));
		assert.deepEqual(fs.readFileSync(indexPath), before);
		assert.equal(
			fs.readFileSync(path.join(foreign, "foreign.txt"), "utf8"),
			"foreign staged content\n",
		);
		assert.equal(git(foreign, ["rev-parse", "HEAD"]), f.baseSha);
	} finally {
		f.repo.dispose();
	}
});

test("C10 C20 | safe content retains one canonical raw staged-diff hash through publication", async () => {
	const f = createFixture();
	try {
		git(f.repo.dir, ["config", "diff.mask.textconv", "printf harmless"]);
		git(f.repo.dir, ["config", "color.diff", "always"]);
		git(f.repo.dir, ["config", "diff.noprefix", "true"]);
		fs.writeFileSync(
			path.join(f.repo.dir, ".gitattributes"),
			"work.txt diff=mask\n",
		);
		fs.writeFileSync(
			path.join(f.repo.dir, "work.txt"),
			"actual safe content\n",
		);
		const [repo] = await runDiscovery(CREATE_SETTINGS, f.scope());
		assert.ok(repo?.explicitPushTargetSnapshot);
		const validation = await processRepoValidationAndDiff(
			repo,
			CREATE_SETTINGS,
		);
		assert.ok(validation.diff.includes("actual safe content"));
		assert.ok(validation.diff.includes("+++ b/work.txt"));
		const result = await executeMultiCommitAndPush(
			repo.path,
			[
				{
					commit: {
						type: "feat",
						description: "safe material",
						isBreaking: false,
					},
					files: [".gitattributes", "work.txt"],
				},
			],
			validation.diffHash,
			CREATE_SETTINGS,
			repo.explicitPushTargetSnapshot,
		);
		assert.equal(result.publishedSha, git(f.repo.dir, ["rev-parse", "HEAD"]));
		assert.equal(
			git(f.remote, ["rev-parse", "refs/heads/task"]),
			result.publishedSha,
		);
	} finally {
		f.repo.dispose();
	}
});
