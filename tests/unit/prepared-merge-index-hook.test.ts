import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	establishPreparedMergeCommit,
	publishEstablishedPreparedMerge,
} from "../../src/modules/git/prepared-merge-publisher.ts";
import { preparedMergeFixture } from "../fixtures/prepared-merge.ts";
import { git } from "../fixtures/targeted-create.ts";

for (const effect of ["marker", "private-index-poisoning", "fsmonitor"])
	test(`review F1: prepared index proof suppresses post-index-change ${effect}`, async () => {
		const f = preparedMergeFixture();
		try {
			const hooks = f.gitPath("index-hooks");
			mkdirSync(hooks);
			const marker = f.gitPath("index-hook-executed");
			const poison =
				effect === "private-index-poisoning"
					? "echo hostile > overlap\ngit -c core.hooksPath=/dev/null add -- overlap\n"
					: "";
			writeFileSync(
				path.join(hooks, "post-index-change"),
				`#!/bin/sh\ncase "$GIT_INDEX_FILE" in *gcp-source-proof-*/index) echo invoked >> ${JSON.stringify(marker)}\n${poison};; esac\nexit 0\n`,
				{ mode: 0o755 },
			);
			f.git(["config", "core.hooksPath", hooks]);
			if (effect === "fsmonitor") {
				const monitor = f.gitPath("proof-fsmonitor");
				writeFileSync(
					monitor,
					`#!/bin/sh\necho "$GIT_INDEX_FILE $(ps -o command= -p "$PPID")" >> ${JSON.stringify(marker)}\nprintf 'prepared-clock\\0'\nexit 0\n`,
					{ mode: 0o755 },
				);
				f.git(["config", "core.fsmonitor", monitor]);
			}
			const repo = establishPreparedMergeCommit(f.scope, await f.validated());
			const published = publishEstablishedPreparedMerge(f.scope, repo);
			assert.equal(published.status, "SUCCESS");
			assert.equal(
				readFileSync(path.join(f.root, "overlap"), "utf8"),
				"caller-approved resolution\n",
				"private proof must not ratify changed working bytes",
			);
			assert.equal(
				existsSync(marker),
				false,
				`prepared private-index writes must not execute hooks: ${existsSync(marker) ? readFileSync(marker, "utf8") : "none"}`,
			);
			assert.equal(f.git(["write-tree"]), f.T);
			assert.equal(
				git(f.remote, ["rev-parse", f.scope.pushRef]),
				published.publishedSha,
			);
		} finally {
			f.repo.dispose();
		}
	});
