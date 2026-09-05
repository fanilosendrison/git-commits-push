import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
	deleteLegacyQueueArtifacts,
	inspectLegacyQueueState,
} from "../../src/modules/reconciliation/legacy-queue-state.ts";

const cleanup: string[] = [];

function createStateDirectory(): string {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "legacy-queue-state-"),
	);
	cleanup.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of cleanup.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("legacy queue state inspection", () => {
	test("accepts readable regular legacy JSON and flag artifacts", () => {
		const stateDirectory = createStateDirectory();
		fs.writeFileSync(
			path.join(stateDirectory, "order-1700000000000-valid.json"),
			JSON.stringify({ orderId: "valid" }),
		);
		fs.writeFileSync(
			path.join(stateDirectory, "order-1700000000001-marker.flag"),
			"",
		);

		const inspection = inspectLegacyQueueState(stateDirectory);

		assert.deepStrictEqual(
			inspection.orderArtifactPaths.map((filePath) => path.basename(filePath)),
			["order-1700000000000-valid.json", "order-1700000000001-marker.flag"],
		);
	});

	test("rejects a symlinked legacy running lock", () => {
		const stateDirectory = createStateDirectory();
		const targetPath = path.join(stateDirectory, "lock-target.json");
		fs.writeFileSync(
			targetPath,
			JSON.stringify({ callerName: "test", runId: "test", timestamp: 1 }),
		);
		fs.symlinkSync(targetPath, path.join(stateDirectory, "running.lock"));

		assert.strictEqual(
			inspectLegacyQueueState(stateDirectory).lock,
			"malformed",
		);
	});

	test("rejects hostile order-like artifact names", () => {
		const stateDirectory = createStateDirectory();
		fs.writeFileSync(
			path.join(stateDirectory, "order-hostile;touch-pwned.flag"),
			"",
		);
		assert.throws(
			() => inspectLegacyQueueState(stateDirectory),
			/legacy order artifact/iu,
		);
	});

	test("archives exact evidence and tolerates a second owner's stale view", () => {
		const stateDirectory = createStateDirectory();
		const artifactPath = path.join(
			stateDirectory,
			"order-1700000000000-migrate.flag",
		);
		fs.writeFileSync(artifactPath, "");
		const firstInspection = inspectLegacyQueueState(stateDirectory);
		const delayedInspection = inspectLegacyQueueState(stateDirectory);

		deleteLegacyQueueArtifacts(stateDirectory, firstInspection);
		assert.strictEqual(fs.existsSync(artifactPath), false);
		assert.strictEqual(
			fs
				.readdirSync(stateDirectory)
				.some((name) => name.startsWith(".gcp-migrated-order-")),
			true,
		);
		assert.doesNotThrow(() =>
			deleteLegacyQueueArtifacts(stateDirectory, delayedInspection),
		);
	});

	test("refuses cleanup when a live lock appears after inspection", () => {
		const stateDirectory = createStateDirectory();
		const inspection = inspectLegacyQueueState(stateDirectory);
		const lockPath = path.join(stateDirectory, "running.lock");
		fs.writeFileSync(
			lockPath,
			JSON.stringify({
				callerName: "racing legacy worker",
				runId: "race",
				timestamp: Date.now(),
			}),
		);

		assert.throws(
			() => deleteLegacyQueueArtifacts(stateDirectory, inspection),
			/state changed after reconciliation admission/iu,
		);
		assert.strictEqual(fs.existsSync(lockPath), true);
	});

	test("rejects malformed, non-regular, and symlink artifacts", () => {
		for (const kind of ["malformed", "directory", "symlink"] as const) {
			const stateDirectory = createStateDirectory();
			const artifactPath = path.join(
				stateDirectory,
				`order-1700000000000-${kind}.json`,
			);
			if (kind === "malformed") {
				fs.writeFileSync(artifactPath, "not-json\n");
			} else if (kind === "directory") {
				fs.mkdirSync(artifactPath);
			} else {
				const targetPath = path.join(stateDirectory, "target.json");
				fs.writeFileSync(targetPath, "{}\n");
				fs.symlinkSync(targetPath, artifactPath);
			}

			assert.throws(
				() => inspectLegacyQueueState(stateDirectory),
				/legacy order artifact/iu,
			);
		}
	});
});
