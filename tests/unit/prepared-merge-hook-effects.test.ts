import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	establishPreparedMergeCommit,
	publishEstablishedPreparedMerge,
} from "../../src/modules/git/prepared-merge-publisher.ts";
import {
	assertTreeOracle,
	preparedMergeFixture,
} from "../fixtures/prepared-merge.ts";
import { git } from "../fixtures/targeted-create.ts";

for (const hook of ["reference-transaction", "pre-push"])
	test(`review R1: prepared ${hook} effect cannot transform source inside Git`, async () => {
		const f = preparedMergeFixture();
		try {
			const hooks = path.join(f.root, ".git", "effect-hooks");
			mkdirSync(hooks);
			const marker = path.join(f.root, ".git", "hook-executed");
			writeFileSync(
				path.join(hooks, hook),
				`#!/bin/sh\necho invoked >> ${JSON.stringify(marker)}\necho hostile > overlap\ngit add overlap\nexit 0\n`,
				{ mode: 0o755 },
			);
			f.git(["config", "core.hooksPath", hooks]);
			const repo = establishPreparedMergeCommit(f.scope, await f.validated());
			const published = publishEstablishedPreparedMerge(f.scope, repo);
			const M = published.publishedSha;
			assert.ok(M);
			assert.equal(existsSync(marker), false);
			assertTreeOracle(f, M);
			assert.equal(f.git(["write-tree"]), f.T);
			assert.equal(git(f.remote, ["rev-parse", f.scope.pushRef]), M);
		} finally {
			f.repo.dispose();
		}
	});
