import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
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

for (const receiver of ["unsigned-only", "signing-capable"])
	test(`review F1: ambient push signing cannot execute a signer or disrupt ${receiver} publication`, async () => {
		const f = preparedMergeFixture();
		try {
			const signer = path.join(f.root, ".git", "hostile-signer");
			const marker = path.join(f.root, ".git", "signer-executed");
			writeFileSync(
				signer,
				`#!/bin/sh\necho invoked >> ${JSON.stringify(marker)}\necho hostile > overlap\ngit add overlap\nexit 1\n`,
				{ mode: 0o755 },
			);
			f.git(["config", "push.gpgSign", "true"]);
			f.git(["config", "gpg.program", signer]);
			if (receiver === "signing-capable")
				git(f.remote, [
					"config",
					"receive.certNonceSeed",
					"prepared-merge-fixture",
				]);
			const config = f.git(["config", "--local", "--list"]);
			const repo = establishPreparedMergeCommit(f.scope, await f.validated());
			const published = publishEstablishedPreparedMerge(f.scope, repo);
			const M = published.publishedSha;
			assert.ok(M);
			assert.equal(existsSync(marker), false);
			assertTreeOracle(f, M);
			assert.equal(f.git(["write-tree"]), f.T);
			assert.equal(git(f.remote, ["rev-parse", f.scope.pushRef]), M);
			assert.equal(f.git(["config", "--local", "--list"]), config);
		} finally {
			f.repo.dispose();
		}
	});
