import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function waitForFile(file, stopped) {
	const deadline = performance.now() + 60_000;
	for (;;) {
		try {
			await access(file);
			return;
		} catch {}
		assert.equal(
			stopped?.(),
			false,
			"Installer exited before its deployment barrier",
		);
		assert.ok(
			performance.now() < deadline,
			"Installer deployment barrier timed out",
		);
		await delay(10);
	}
}

export async function controlledInstall(
	fixture,
	moduleUrl,
	expectedReleaseName,
	nextExpectedReleaseName,
) {
	const directory = await mkdtemp(path.join(fixture.root, "control-"));
	const ready = path.join(directory, "ready.json");
	const proceed = path.join(directory, "proceed");
	const result = path.join(directory, "result.json");
	const control = path.join(directory, "control.json");
	const job = path.join(directory, "job.json");
	await writeFile(
		control,
		JSON.stringify({
			pnpmCliPath: fixture.options.pnpmCliPath,
			ready,
			proceed,
		}),
	);
	await writeFile(
		job,
		JSON.stringify({
			options: {
				sourceDirectory: fixture.options.sourceDirectory,
				homeDirectory: fixture.options.homeDirectory,
				pnpmCliPath: path.join(
					import.meta.dirname,
					"standalone-pin-deploy-barrier.mjs",
				),
				expectedReleaseName,
			},
			nextExpectedReleaseName,
			ready,
			proceed,
			result,
		}),
	);
	const child = spawn(
		process.execPath,
		[
			path.join(import.meta.dirname, "standalone-pin-worker.mjs"),
			moduleUrl,
			job,
		],
		{
			env: { ...fixture.options.environment, GCP_PIN_TEST_CONTROL: control },
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		},
	);
	let stopped = false;
	let stdout = "",
		stderr = "";
	child.stdout.on("data", (bytes) => {
		stdout += bytes;
	});
	child.stderr.on("data", (bytes) => {
		stderr += bytes;
	});
	const settled = new Promise((resolve) => {
		child.once("error", (error) => {
			stopped = true;
			resolve({ code: null, signal: null, error: error.message });
		});
		child.once("close", async (code, signal) => {
			stopped = true;
			try {
				await writeFile(path.join(directory, "stdout.log"), stdout);
				await writeFile(path.join(directory, "stderr.log"), stderr);
				resolve({ code, signal });
			} catch (error) {
				resolve({ code, signal, error: error.message });
			}
		});
	});
	return {
		child,
		ready,
		proceed,
		result,
		settled,
		async entered() {
			await waitForFile(ready, () => stopped);
			return JSON.parse(await readFile(ready));
		},
		async release() {
			await writeFile(proceed, "continue\n");
		},
		async outcome() {
			const exit = await Promise.race([
				settled,
				delay(60_000, undefined, { ref: false }).then(() => {
					throw new Error("Installer worker did not terminate");
				}),
			]);
			assert.equal(exit.code, 0, stderr);
			return JSON.parse(await readFile(result));
		},
		async crashAtDeployment() {
			const boundary = await this.entered();
			assert.equal(boundary.parentPid, child.pid);
			// Keep the real worker unreaped/stopped before killing its known direct child.
			assert.equal(child.kill("SIGSTOP"), true);
			const deadline = performance.now() + 10_000;
			while (
				!execFileSync("ps", ["-o", "stat=", "-p", String(child.pid)], {
					encoding: "utf8",
				})
					.trim()
					.startsWith("T")
			) {
				assert.ok(
					performance.now() < deadline,
					"Worker SIGSTOP acknowledgement missing",
				);
				await delay(10);
			}
			process.kill(boundary.pid, "SIGKILL");
			assert.equal(child.kill("SIGKILL"), true);
			const exit = await settled;
			assert.equal(exit.signal, "SIGKILL");
		},
		async cleanup() {
			await writeFile(proceed, "continue\n");
			if (!stopped) await settled;
		},
	};
}
