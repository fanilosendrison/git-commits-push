import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
	assertTreeOracle,
	preparedMergeFixture,
} from "../fixtures/prepared-merge.ts";
import {
	installCreateQualification,
	startInstalled,
	withCreateFixture,
} from "./fixtures/create-installed-qualification.mjs";
import { runGit, waitForFile } from "./fixtures/reconciler-e2e-helpers.mjs";

let installed;
before(async () => {
	installed = await installCreateQualification();
});
after(async () => {
	await installed?.cleanup();
});

function durableState(runDirectory) {
	const db = new DatabaseSync(path.join(runDirectory, "turnlock.sqlite3"), {
		readOnly: true,
	});
	try {
		const row = db
			.prepare(
				"SELECT state_json, state_digest FROM run_state WHERE singleton = 1",
			)
			.get();
		assert.equal(
			`sha256:${createHash("sha256").update(row.state_json).digest("hex")}`,
			row.state_digest,
		);
		return JSON.parse(row.state_json);
	} finally {
		db.close();
	}
}

for (const mode of [
	"before-commit",
	"after-commit",
	"lost-commit-ack",
	"pending-report",
])
	test(`installed ${mode}: real interruption resumes exact durable authority without substitute history`, async () => {
		await withCreateFixture(installed, async (base) => {
			const f = preparedMergeFixture();
			let launch;
			try {
				const fixture = { ...base, args: f.args };
				const marker = path.join(base.root, "interrupted.json");
				const preload = pathToFileURL(
					path.join(
						import.meta.dirname,
						"fixtures/prepared-merge-interruption.mjs",
					),
				).href;
				launch = startInstalled(installed, fixture, f.args, {
					NODE_OPTIONS: `--import=${preload}`,
					GCP_TEST_MERGE_INTERRUPT: mode,
					GCP_TEST_MERGE_MARKER: marker,
				});
				await waitForFile(marker, 90_000);
				launch.child.kill("SIGTERM");
				const interrupted = await launch.done();
				assert.notEqual(interrupted.code, 0, interrupted.output);
				const runsRoot = path.join(
					base.env.TURNLOCK_RUN_DIR_ROOT,
					"git-commits-push-tl",
				);
				const runs = await readdir(runsRoot);
				assert.equal(runs.length, 1);
				const runId = runs[0];
				const prior = durableState(path.join(runsRoot, runId));
				const repo = Object.values(prior.data.repos)[0];
				assert.deepEqual(prior.data.invocationScope, f.scope);
				assert.equal(repo.validatedSource.expectedTreeSha, f.T);
				const expected = repo.validatedSource.preparedMerge.expectedCommitSha;
				const before = f.git(["rev-parse", "HEAD"]);
				assert.equal(before, mode === "before-commit" ? f.D : expected);
				assert.equal(
					runGit(f.remote, ["rev-parse", f.scope.pushRef], base.env),
					mode === "pending-report" ? expected : f.D,
				);
				if (mode === "after-commit")
					assert.equal(repo.committedShas[0].sha, expected);
				if (mode === "lost-commit-ack")
					assert.equal(
						repo.committedShas,
						undefined,
						"ref effect must precede its application acknowledgement",
					);
				if (mode === "before-commit") {
					const manifest = path.join(
						runsRoot,
						runId,
						"external-requests",
						"prepared-merge-commit.json",
					);
					const original = await readFile(manifest, "utf8");
					const { handlePreparedMergeRequest } = await import(
						pathToFileURL(
							path.join(
								installed.releaseDirectory,
								"dist/src/modules/turnlock/prepared-merge-request.js",
							),
						).href
					);
					const previousRoot = process.env.TURNLOCK_RUN_DIR_ROOT;
					try {
						process.env.TURNLOCK_RUN_DIR_ROOT = base.env.TURNLOCK_RUN_DIR_ROOT;
						await writeFile(manifest, `${original}\n`);
						assert.throws(
							() => handlePreparedMergeRequest(manifest, `${original}\n`),
							/current exact durable operation/,
						);
						const unsupported = {
							...JSON.parse(original),
							requestType: "git.arbitrary.effect",
						};
						assert.throws(() =>
							handlePreparedMergeRequest(manifest, JSON.stringify(unsupported)),
						);
						assert.equal(f.git(["rev-parse", "HEAD"]), f.D);
					} finally {
						await writeFile(manifest, original);
						if (previousRoot === undefined)
							delete process.env.TURNLOCK_RUN_DIR_ROOT;
						else process.env.TURNLOCK_RUN_DIR_ROOT = previousRoot;
					}
				}
				if (mode === "pending-report") {
					assert.equal(
						prior.pendingExternalRequest.requestType,
						"git.prepared-merge.report",
					);
					assert.equal(prior.terminalResult, undefined);
					assert.equal(repo.publishedSha, expected);
					runGit(f.remote, ["update-ref", "-d", f.scope.pushRef], base.env);
				}
				const resumed = await startInstalled(
					installed,
					fixture,
					["--resume", "--run-id", runId],
					{ NODE_OPTIONS: "" },
				).done();
				assert.equal(resumed.code, 0, resumed.output);
				assert.equal(f.git(["rev-parse", "HEAD"]), expected);
				assert.equal(
					f.git(["show", "-s", "--format=%P", expected]),
					`${f.D} ${f.C}`,
				);
				assertTreeOracle(f, expected);
				assert.equal(
					f.git(["rev-list", "--first-parent", "--count", `${f.D}..HEAD`]),
					"1",
				);
				assert.equal(
					runGit(
						f.remote,
						["for-each-ref", "--format=%(objectname)", f.scope.pushRef],
						base.env,
					),
					mode === "pending-report" ? "" : expected,
				);
				assert.equal(existsSync(f.gitPath("MERGE_HEAD")), false);
				const final = durableState(path.join(runsRoot, runId));
				assert.equal(Object.values(final.data.repos)[0].publishedSha, expected);
				// A reporting-only continuation must not recreate a subsequently deleted destination.
				runGit(f.remote, ["update-ref", "-d", f.scope.pushRef], base.env);
				const report = await startInstalled(
					installed,
					fixture,
					["--resume", "--run-id", runId],
					{ NODE_OPTIONS: "" },
				).done();
				assert.equal(report.code, 0, report.output);
				assert.equal(
					runGit(
						f.remote,
						["for-each-ref", "--format=%(objectname)", f.scope.pushRef],
						base.env,
					),
					"",
				);
				assert.equal(f.git(["rev-parse", "HEAD"]), expected);
			} finally {
				if (
					launch?.child.exitCode === null &&
					launch.child.signalCode === null
				) {
					launch.child.kill("SIGTERM");
					await launch.done();
				}
				f.repo.dispose();
			}
		});
	});
